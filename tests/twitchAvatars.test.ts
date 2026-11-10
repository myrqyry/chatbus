import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTwitchAvatarCache, fetchTwitchUserAvatar } from '../src/index';

const avatar = 'https://static-cdn.jtvnw.net/jtv_user_pictures/example-profile_image-600x600.png';

describe('Twitch profile pictures for chat identity badges', () => {
  beforeEach(() => { clearTwitchAvatarCache(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); clearTwitchAvatarCache(); });

  it('resolves a broadcaster portrait from the public Twitch identity response and caches it', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify([{ id: '42', login: 'caster', logo: avatar }]), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchTwitchUserAvatar('  Caster  ')).toBe(avatar);
    expect(await fetchTwitchUserAvatar('caster')).toBe(avatar);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('login=caster');
  });

  it('coalesces simultaneous requests for the same user', async () => {
    let complete!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { complete = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    const first = fetchTwitchUserAvatar('streamer');
    const second = fetchTwitchUserAvatar('STREAMER');
    expect(fetcher).toHaveBeenCalledTimes(1);
    complete(new Response(JSON.stringify([{ logo: avatar }]), { status: 200 }));
    expect(await Promise.all([first, second])).toEqual([avatar, avatar]);
  });

  it('rejects untrusted artwork URLs and invalid usernames', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify([{ logo: 'https://example.com/fake.png' }]), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchTwitchUserAvatar('caster')).toBeNull();
    expect(await fetchTwitchUserAvatar('bad/name')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('degrades to no avatar when the provider is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network unavailable'); }));
    expect(await fetchTwitchUserAvatar('caster')).toBeNull();
  });
});
