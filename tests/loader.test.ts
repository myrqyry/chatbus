import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchChannelEmotesDetailed } from '../src/emotes/loader';
import { clearCachedEmotes, writeCachedEmotes } from '../src/emotes/cache';
import type { EmoteFetchResult } from '../src/types/emotes';

const legacySnapshot = (code: string): EmoteFetchResult => ({
  emotes: {
    [code]: { code, id: `old-${code}`, url: `https://cdn.7tv.app/${code}.webp`, zeroWidth: false, provider: '7tv' },
  },
  providers: [], fromCache: false, complete: true,
  // Old chat-core / Chatbus caches did not retain scoped candidates.
});

const successfulProviderFetch = (input: RequestInfo | URL): Response => {
  const url = String(input);
  if (url.includes('api.ivr.fi')) return new Response('[]', { status: 200 });
  if (url.includes('7tv.io/v3/emote-sets/global')) return new Response(JSON.stringify({
    emotes: [{ id: 'new-1', name: 'NEWGLOBAL', flags: 0, data: {
      host: { url: '//cdn.7tv.app/emote/new-1', files: [{ name: '1x.webp', width: 32, height: 32 }] },
    } }],
  }), { status: 200 });
  if (url.includes('betterttv.net/3/cached/emotes/global')) return new Response('[]', { status: 200 });
  if (url.includes('frankerfacez.com/v1/set/global')) return new Response('{"sets":{}}', { status: 200 });
  if (url.includes('7tv.io/v3/users/twitch/')) return new Response('{}', { status: 404 });
  if (url.includes('frankerfacez.com/v1/room/')) return new Response('{}', { status: 404 });
  return new Response('{}', { status: 404 });
};

describe('fetchChannelEmotesDetailed', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shares the underlying request while allowing one consumer to abort', async () => {
    let resolveUser: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('api.ivr.fi')) {
        return new Promise<Response>((resolve) => { resolveUser = resolve; });
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const firstController = new AbortController();
    const first = fetchChannelEmotesDetailed(' Shared-Channel ', { signal: firstController.signal });
    const firstSettled = first.then(() => 'resolved', (error: Error) => `rejected:${error.name}`);
    const second = fetchChannelEmotesDetailed('shared-channel');
    firstController.abort();
    await vi.waitFor(() => expect(resolveUser).toBeDefined());
    resolveUser?.(new Response(JSON.stringify([{ id: '123' }]), { status: 200 }));

    await expect(firstSettled).resolves.toBe('rejected:AbortError');
    await expect(second).resolves.toMatchObject({ complete: false, fromCache: false });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('api.ivr.fi'))).toHaveLength(1);
  });

  it('marks the BTTV channel result degraded when Twitch ID resolution really fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.ivr.fi')) return new Response('{}', { status: 503 });
      if (url.includes('7tv.io/v3/emote-sets/global')) return new Response(JSON.stringify({ emotes: [] }), { status: 200 });
      if (url.includes('betterttv.net/3/cached/emotes/global')) return new Response(JSON.stringify([]), { status: 200 });
      if (url.includes('frankerfacez.com/v1/set/global')) return new Response(JSON.stringify({ sets: {} }), { status: 200 });
      if (url.includes('7tv.io/v3/users/twitch/')) return new Response('{}', { status: 404 });
      if (url.includes('frankerfacez.com/v1/room/')) return new Response('{}', { status: 404 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchChannelEmotesDetailed('lookup-failure-test', { bypassCache: true });
    const bttvChannel = result.providers.find((status) => status.provider === 'bttv' && status.scope === 'channel');

    expect(result.complete).toBe(false);
    expect(bttvChannel).toMatchObject({ ok: false, count: 0 });
    expect(bttvChannel?.error).toContain('Twitch user lookup failed');
  });

  it('does not cache a degraded result and retries it on the next call', async () => {
    let failGlobalSevenTv = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.ivr.fi')) return new Response(JSON.stringify([]), { status: 200 });
      if (url.includes('7tv.io/v3/emote-sets/global')) {
        return failGlobalSevenTv
          ? new Response('{}', { status: 503 })
          : new Response(JSON.stringify({ emotes: [] }), { status: 200 });
      }
      if (url.includes('betterttv.net/3/cached/emotes/global')) return new Response(JSON.stringify([]), { status: 200 });
      if (url.includes('frankerfacez.com/v1/set/global')) return new Response(JSON.stringify({ sets: {} }), { status: 200 });
      if (url.includes('7tv.io/v3/users/twitch/')) return new Response('{}', { status: 404 });
      if (url.includes('frankerfacez.com/v1/room/')) return new Response('{}', { status: 404 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchChannelEmotesDetailed('cache-recovery-test');
    expect(first).toMatchObject({ complete: false, fromCache: false });
    const callsAfterFirst = fetchMock.mock.calls.length;

    failGlobalSevenTv = false;
    const second = await fetchChannelEmotesDetailed('cache-recovery-test');
    expect(second).toMatchObject({ complete: true, fromCache: false });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);

    const callsAfterSecond = fetchMock.mock.calls.length;
    const third = await fetchChannelEmotesDetailed('cache-recovery-test');
    expect(third).toMatchObject({ complete: true, fromCache: true });
    expect(fetchMock.mock.calls).toHaveLength(callsAfterSecond);
  });

  it('recovers scoped candidate metadata from legacy cache snapshots once and caches the complete replacement', async () => {
    const channel = 'legacy-candidate-recovery';
    clearCachedEmotes(channel);
    writeCachedEmotes(channel, legacySnapshot('OLDGLOBAL'));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => successfulProviderFetch(input));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchChannelEmotesDetailed(' LEGACY-CANDIDATE-RECOVERY ');
    expect(result).toMatchObject({ complete: true, fromCache: false });
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'NEWGLOBAL', scope: 'global', provider: '7tv' }),
    ]));
    expect(result.emotes.NEWGLOBAL).toBeDefined();
    expect(result.emotes.OLDGLOBAL).toBeUndefined();

    const callsAfterRecovery = fetchMock.mock.calls.length;
    const cached = await fetchChannelEmotesDetailed(channel);
    expect(cached).toMatchObject({ complete: true, fromCache: true });
    expect(cached.candidates?.[0]?.scope).toBe('global');
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterRecovery);
  });

  it('keeps a complete legacy cache when a candidate-metadata refresh is degraded, then retries later', async () => {
    const channel = 'legacy-candidate-degraded';
    clearCachedEmotes(channel);
    writeCachedEmotes(channel, legacySnapshot('KEEPGLOBAL'));
    let degraded = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (
      degraded && String(input).includes('7tv.io/v3/emote-sets/global')
        ? new Response('{}', { status: 503 })
        : successfulProviderFetch(input)
    ));
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchChannelEmotesDetailed(channel);
    expect(first).toMatchObject({ complete: true, fromCache: true });
    expect(first.emotes.KEEPGLOBAL?.code).toBe('KEEPGLOBAL');
    expect(first.emotes.NEWGLOBAL).toBeUndefined();
    expect(first.candidates).toBeUndefined();

    const firstRequests = fetchMock.mock.calls.length;
    degraded = false;
    const second = await fetchChannelEmotesDetailed(channel);
    expect(second).toMatchObject({ complete: true, fromCache: false });
    expect(second.candidates?.[0]?.scope).toBe('global');
    expect(fetchMock.mock.calls.length).toBeGreaterThan(firstRequests);
  });

  it('shares legacy-cache recovery while one caller aborts without interrupting another', async () => {
    const channel = 'legacy-candidate-shared';
    clearCachedEmotes(channel);
    writeCachedEmotes(channel, legacySnapshot('ORIGINAL'));
    let release: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('api.ivr.fi')) {
        return new Promise<Response>((resolve) => { release = resolve; });
      }
      return Promise.resolve(successfulProviderFetch(input));
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const first = fetchChannelEmotesDetailed(channel, { signal: controller.signal });
    const second = fetchChannelEmotesDetailed(channel);
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(release).toBeDefined());
    release?.(new Response('[]', { status: 200 }));
    const recovered = await second;

    expect(recovered).toMatchObject({ complete: true, fromCache: false });
    expect(recovered.candidates?.[0]?.scope).toBe('global');
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('api.ivr.fi'))).toHaveLength(1);
  });
});
