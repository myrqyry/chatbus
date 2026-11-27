import { describe, expect, it, vi } from 'vitest';
const {irc,load}=vi.hoisted(()=>({irc:vi.fn(),load:vi.fn()}));
vi.mock('../src/platforms/twitch/irc',()=>({connectTwitchIrcChat:irc}));
vi.mock('../src/emotes/loader',()=>({fetchChannelEmotesDetailed:load}));
import { browserPublicPlatforms, createBrowserChatSource } from '../src/browser';
describe('browser public chat transport',()=>{
 it('advertises only the verified public browser transports',()=>{
  expect(browserPublicPlatforms).toEqual(['twitch']);
 });
 it('reuses the anonymous IRC and emote loader and owns cancellation',async()=>{
  const close=vi.fn();
  irc.mockReturnValue({close});
  load.mockResolvedValue({emotes:{},complete:true});
  const source=createBrowserChatSource();
  const event=vi.fn(),state=vi.fn(),error=vi.fn(),getEmotes=()=>({});
  const handle=source.connect({platform:'twitch',channel:'Example',getEmotes,onEvent:event,onStateChange:state,onError:error});
  expect(irc).toHaveBeenCalledWith(expect.objectContaining({channel:'Example',getEmotes,onEvent:event,onStateChange:state,onError:error}));
  expect(await source.emotes('Example','twitch')).toEqual({emotes:{},complete:true});
  handle.close();
  expect(close).toHaveBeenCalledOnce();
 });
 it('does not pretend an unsupported provider is direct or invoke IRC for it',async()=>{
  irc.mockClear();
  const source=createBrowserChatSource();
  for(const platform of ['kick','youtube','tiktok'] as const){
   expect(()=>source.connect({platform,channel:'example',getEmotes:()=>({}),onEvent:vi.fn()})).toThrow(/relay/i);
   await expect(source.emotes('example',platform)).rejects.toThrow(/relay/i);
  }
  expect(irc).not.toHaveBeenCalled();
 });
});
