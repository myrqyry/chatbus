import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearBadgeCaches,
  clearSevenTvUserCosmeticsCache,
  fetchBttvBadgesForUser,
  fetchFfzBadgesForUser,
  fetchSevenTvUserCosmeticsDetailed,
  fetchTwitchChannelBadgesDetailed,
  mergeBadges,
  parseTwitchBadgeRefs,
  resolveBadgeRefs,
} from '../src/index';
import type { Badge } from '../src/index';

describe('badges', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearBadgeCaches();
  });

  it('parses and resolves native Twitch badge references', () => {
    const refs = parseTwitchBadgeRefs({ moderator: '1' }, { moderator: '12' });
    const catalog: Badge[] = [{
      id: 'moderator', version: '1', provider: 'twitch', scope: 'global',
      title: 'Moderator', images: [{ url: 'https://static.example/mod.png' }],
    }];
    expect(refs).toEqual([{ id: 'moderator', version: '1', provider: 'twitch', info: '12' }]);
    expect(resolveBadgeRefs(refs, catalog)).toEqual(catalog);
  });

  it('fetches Twitch first-party badge assets with caller auth', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Client-Id')).toBe('client');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token');
      return new Response(JSON.stringify({ data: [{ set_id: 'vip', versions: [{
        id: '1', image_url_1x: 'https://static.example/vip.png', title: 'VIP', description: 'Very Important Person',
      }] }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchTwitchChannelBadgesDetailed('123', { clientId: 'client', accessToken: 'token' });
    expect(result.ok).toBe(true);
    expect(result.value?.[0]).toMatchObject({ id: 'vip', version: '1', provider: 'twitch', scope: 'channel' });
  });

  it('loads BTTV and FFZ user badges', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('betterttv')) {
        return new Response(JSON.stringify([{ id: 'b1', name: 'SomeUser', badge: {
          description: 'BTTV Person', svg: 'https://cdn.example/badge.svg',
        } }]), { status: 200 });
      }
      return new Response(JSON.stringify({
        badges: [{ id: 2, title: 'FFZ Person', slot: 5, replaces: 'subscriber', urls: { '1': '//cdn.example/ffz.png' } }],
        users: { '2': ['someuser'] },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchBttvBadgesForUser('someuser')).toMatchObject([{ provider: 'bttv', scope: 'user' }]);
    expect(await fetchFfzBadgesForUser('SomeUser')).toMatchObject([{ provider: 'ffz', replaces: 'subscriber' }]);
  });

  it('reuses provider badge catalogs across users until the cache expires', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      { id: 'b1', name: 'One', badge: { svg: 'https://cdn.example/1.svg' } },
      { id: 'b2', name: 'Two', badge: { svg: 'https://cdn.example/2.svg' } },
    ]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchBttvBadgesForUser('One');
    await fetchBttvBadgesForUser('Two');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('lets a provider badge replace a native badge by id', () => {
    const native: Badge = {
      id: 'subscriber', provider: 'twitch', scope: 'channel', images: [{ url: 'https://example/sub.png' }],
    };
    const ffz: Badge = {
      id: 'supporter', provider: 'ffz', scope: 'user', replaces: 'subscriber', slot: 1,
      images: [{ url: 'https://example/ffz.png' }],
    };
    expect(mergeBadges([native], [ffz])).toEqual([ffz]);
  });
});

describe('7TV cosmetics', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearSevenTvUserCosmeticsCache();
  });

  it('returns renderer-neutral name paint and badge metadata', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/users/twitch/123')) {
        return new Response(JSON.stringify({
          user: { id: '7user', username: 'someuser', display_name: 'SomeUser', style: { paint_id: 'paint1', badge_id: 'badge1' } },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { cosmetics: {
        paints: [{
          id: 'paint1', name: 'Sunset', color: 123,
          gradients: [{ function: 'LINEAR_GRADIENT', angle: 45, stops: [{ at: 0, color: 1 }, { at: 1, color: 2 }] }],
          shadows: [{ x_offset: 1, y_offset: 2, radius: 3, color: 4 }],
        }],
        badges: [{ id: 'badge1', name: 'Cool', tooltip: 'Cool badge', host: {
          url: '//cdn.7tv.app/badge/badge1', files: [{ name: '3x.webp', width: 96, height: 96, format: 'WEBP' }],
        } }],
      } } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSevenTvUserCosmeticsDetailed('123');
    expect(result.ok).toBe(true);
    expect(result.value?.namePaint).toMatchObject({
      id: 'paint1', provider: '7tv', gradients: [{ angle: 45 }], shadows: [{ xOffset: 1, yOffset: 2, radius: 3 }],
    });
    expect(result.value?.badges[0]).toMatchObject({ id: 'badge1', provider: '7tv', scope: 'user' });
    expect(result.value?.badges[0].images[0].url).toBe('https://cdn.7tv.app/badge/badge1/3x.webp');

    await fetchSevenTvUserCosmeticsDetailed('123');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('parses observed v3 legacy paints with signed ARGB, repeat, shadows and text styling', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/users/twitch/')) {
        return new Response(JSON.stringify({
          user: { id: '7user', style: { paint_id: '01FQ8S87J8000BDD0YMN21KEXG' } },
        }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { query: string; variables: { list: string[] } };
      expect(body.query).toContain('text {');
      expect(body.variables.list).toEqual(['01FQ8S87J8000BDD0YMN21KEXG']);
      return new Response(JSON.stringify({ data: { cosmetics: { paints: [{
        id: '01FQ8S87J8000BDD0YMN21KEXG', name: 'Candy Cane',
        function: 'LINEAR_GRADIENT', angle: 45, repeat: true, gradients: [],
        stops: [{ at: 0.1, color: -757935361 }, { at: 0.2, color: -10197761 }],
        shadows: [{ x_offset: -1, y_offset: 0, radius: 0.7, color: 102 }],
        text: { weight: 6, transform: 'uppercase', stroke: { width: 2, color: -757935361 },
          shadows: [{ x_offset: 1, y_offset: 2, radius: 3, color: -10197761 }] },
      }], badges: [] } } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchSevenTvUserCosmeticsDetailed('123');
    expect(result.ok).toBe(true);
    expect(result.value?.namePaint).toMatchObject({
      id: '01FQ8S87J8000BDD0YMN21KEXG',
      function: 'LINEAR_GRADIENT', repeat: true, angle: 45,
      stops: [{ at: 0.1, color: -757935361 }, { at: 0.2, color: -10197761 }],
      text: { weight: 6, transform: 'uppercase', stroke: { width: 2, color: -757935361 },
        shadows: [{ xOffset: 1, yOffset: 2, radius: 3, color: -10197761 }] },
    });
  });

  it('treats a Twitch user with no 7TV account as an ordinary empty result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    await expect(fetchSevenTvUserCosmeticsDetailed('missing')).resolves.toEqual({ value: null, ok: true });
  });
});
