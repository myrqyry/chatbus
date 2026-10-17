import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchChannelBttv,
  fetchChannelFfz,
  fetchChannelSevenTv,
  fetchGlobalBttv,
  fetchGlobalFfz,
} from '../src/index';

describe('provider adapters', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('uses the active 7TV zero-width assignment instead of the base recommendation', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/users/twitch/123')) {
        return new Response(JSON.stringify({ emote_set: { id: 'set-1' } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        emotes: [
          {
            id: 'emote-entry-flag', name: 'EntryOverlay', flags: 1,
            data: { host: { url: '//cdn.7tv.app/emote/entry', files: [{ name: '4x.webp', width: 128, height: 128 }] } },
          },
          {
            id: 'emote-data-flag', name: 'DataRecommendationOnly',
            data: { flags: 256, host: { url: '//cdn.7tv.app/emote/data', files: [{ name: '4x.webp' }] } },
          },
        ],
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchChannelSevenTv('channel', '123');

    expect(result.status).toMatchObject({ provider: '7tv', scope: 'channel', ok: true, count: 2 });
    expect(result.candidates.map((candidate) => candidate.zeroWidth)).toEqual([true, false]);
    expect(result.candidates[0]).toMatchObject({
      modifier: 'overlay',
      images: [{ width: 128, height: 128 }],
    });
    expect(result.candidates[1].modifier).toBeUndefined();
  });

  it('maps FFZ modifiers into overlay and hidden semantics', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ sets: { '1': { emoticons: [
      { id: 7, name: 'Overlay', modifier: true, modifier_flags: 0, urls: { '1': '//cdn.example/7' } },
      { id: 8, name: 'Hidden', modifier: true, modifier_flags: 1, urls: { '1': '//cdn.example/8' } },
      { id: 9, name: 'Hyper', modifier: true, modifier_flags: 12289, urls: { '1': '//cdn.example/9' } },
    ] } } }), { status: 200 })));

    const result = await fetchGlobalFfz();
    expect(result.candidates[0]).toMatchObject({ modifier: 'overlay', zeroWidth: true });
    expect(result.candidates[1]).toMatchObject({ modifier: 'hidden', zeroWidth: false });
    expect(result.candidates[0]).toMatchObject({ modifierFlags: 0 });
    expect(result.candidates[1]).toMatchObject({ modifierFlags: 1 });
    expect(result.candidates[2]).toMatchObject({ modifier: 'hidden', modifierFlags: 12289 });
  });

  it('parses global BTTV and FFZ candidates', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('betterttv')) {
        return new Response(JSON.stringify([{ id: 'bttv-1', code: 'GlobalBTTV', animated: true }]), { status: 200 });
      }
      return new Response(JSON.stringify({ sets: { '1': { emoticons: [{ id: 7, name: 'GlobalFFZ', urls: { '1': '//cdn.example.com/7' } }] } } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const [bttv, ffz] = await Promise.all([fetchGlobalBttv(), fetchGlobalFfz()]);

    expect(bttv.candidates[0]).toMatchObject({ code: 'GlobalBTTV', scope: 'global', animated: true });
    expect(ffz.candidates[0]).toMatchObject({ code: 'GlobalFFZ', url: 'https://cdn.example.com/7', scope: 'global' });
  });

  it('treats a missing optional channel provider account as an empty success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));

    const [bttv, ffz, sevenTv] = await Promise.all([
      fetchChannelBttv('123'),
      fetchChannelFfz('channel'),
      fetchChannelSevenTv('channel', '123'),
    ]);

    expect(bttv).toMatchObject({ candidates: [], status: { ok: true, count: 0 } });
    expect(ffz).toMatchObject({ candidates: [], status: { ok: true, count: 0 } });
    expect(sevenTv).toMatchObject({ candidates: [], status: { ok: true, count: 0 } });
  });

  it('reports a real 7TV channel provider failure instead of silently succeeding', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));

    const result = await fetchChannelSevenTv('channel', '123');

    expect(result.candidates).toEqual([]);
    expect(result.status).toMatchObject({ provider: '7tv', scope: 'channel', ok: false, count: 0 });
    expect(result.status.error).toContain('503');
  });
});
