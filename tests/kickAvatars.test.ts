import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearKickAvatarCache, fetchKickUserAvatar } from '../src/index';

const avatar = 'https://files.kick.com/images/user/93786/profile_image/conversion/b21d2c10-257e-4f64-adb4-6044d57751ab-fullsize.webp';
const response = (profile_pic: unknown = avatar, id: unknown = 93786) =>
  new Response(JSON.stringify({id:92723,slug:'nickwhite',user:{id,username:'nickwhite',profile_pic}}),{status:200});

describe('Kick channel owner avatars',()=>{
  beforeEach(()=>clearKickAvatarCache());
  afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();clearKickAvatarCache();});

  it('uses Kick public channel user.profile_pic, not HTML or a guessed URL; caches a verified URL',async()=>{
    const fetcher=vi.fn(async (_input:RequestInfo | URL)=>response());
    vi.stubGlobal('fetch',fetcher);
    expect(await fetchKickUserAvatar('  NickWhite  ')).toBe(avatar);
    expect(await fetchKickUserAvatar('nickwhite')).toBe(avatar);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://kick.com/api/v2/channels/nickwhite');
  });

  it('coalesces concurrent avatar lookup for the same channel and normalizes its slug',async()=>{
    let finish!:(res:Response)=>void;
    const fetcher=vi.fn((_input:RequestInfo | URL)=>new Promise<Response>(resolve=>{finish=resolve;}));
    vi.stubGlobal('fetch',fetcher);
    const first=fetchKickUserAvatar('NickWhite');
    const second=fetchKickUserAvatar('nickwhite');
    expect(fetcher).toHaveBeenCalledTimes(1);
    finish(response());
    expect(await Promise.all([first,second])).toEqual([avatar,avatar]);
  });

  it('rejects unrelated, insecure, malformed, or mismatched user artwork',async()=>{
    const fetcher=vi.fn(async (_input:RequestInfo | URL)=>response('https://evil.test/images/user/93786/profile_image/fake.webp'));
    vi.stubGlobal('fetch',fetcher);
    expect(await fetchKickUserAvatar('nickwhite')).toBeNull();
    expect(await fetchKickUserAvatar('bad/name')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    clearKickAvatarCache();
    fetcher.mockImplementationOnce(async()=>response(avatar,999));
    expect(await fetchKickUserAvatar('nickwhite')).toBeNull();
    clearKickAvatarCache();
    fetcher.mockImplementationOnce(async()=>response('http://files.kick.com/images/user/93786/profile_image/fake.webp'));
    expect(await fetchKickUserAvatar('nickwhite')).toBeNull();
  });

  it('returns null when an account has no avatar or the optional lookup fails',async()=>{
    const fetcher=vi.fn(async (_input:RequestInfo | URL)=>response(null));
    vi.stubGlobal('fetch',fetcher);
    expect(await fetchKickUserAvatar('nickwhite')).toBeNull();
    clearKickAvatarCache();
    fetcher.mockImplementationOnce(async()=>{throw new Error('kick temporarily unavailable')});
    expect(await fetchKickUserAvatar('nickwhite')).toBeNull();
  });
});
