import { describe, expect, it, vi } from 'vitest';
const {irc,load,kick,resolve,global,channel,transport,youtube}=vi.hoisted(()=>({irc:vi.fn(),load:vi.fn(),kick:vi.fn(),resolve:vi.fn(),global:vi.fn(),channel:vi.fn(),transport:vi.fn(),youtube:vi.fn()}));
vi.mock('../src/platforms/twitch/irc',()=>({connectTwitchIrcChat:irc}));
vi.mock('../src/emotes/loader',()=>({fetchChannelEmotesDetailed:load}));
vi.mock('../src/platforms/kick/connect',()=>({connectKickChat:kick}));
vi.mock('../src/platforms/kick/channel',()=>({resolveKickChannel:resolve}));
vi.mock('../src/emotes/sevenTv',()=>({fetchGlobalSevenTv:global,fetchKickChannelSevenTv:channel}));
vi.mock('../src/platforms/youtube/connect',()=>({connectYouTubeChat:youtube}));
import { browserPublicPlatforms, createBrowserChatSource } from '../src/browser';
describe('browser public chat transport',()=>{
 it('advertises only the verified public browser transports',()=>{
  expect(browserPublicPlatforms).toEqual(['twitch','kick']);
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
 it('reuses Kick connector, resolves public metadata at socket reconnect, and closes pending handles',async()=>{
  let finish!:(v:{close:()=>void})=>void;
  kick.mockImplementation(()=>new Promise(r=>{finish=r}));
  const close=vi.fn(),onEvent=vi.fn();
  const source=createBrowserChatSource({loadKickPublicTransport:transport});
  const handle=source.connect({platform:'kick',channel:'example',getEmotes:()=>({}),onEvent});
  expect(kick).toHaveBeenCalledWith(expect.objectContaining({
   channel:'example',socket:{resolvePublicPusher:transport},emitInitialHistory:false,
   signal:expect.any(AbortSignal),
  }));
  const options=kick.mock.calls.at(-1)![0];
  handle.close();
  expect(options.signal.aborted).toBe(true);
  options.onEvent({type:'message'});
  expect(onEvent).not.toHaveBeenCalled();
  finish({close});
  await Promise.resolve();
  expect(close).toHaveBeenCalledOnce();
 });
 it('loads global and channel Kick 7TV without a relay',async()=>{
  resolve.mockResolvedValue({channelId:'42'});
  global.mockResolvedValue({candidates:[],status:{ok:true}});
  channel.mockResolvedValue({candidates:[],status:{ok:false}});
  expect(await createBrowserChatSource().emotes('example','kick')).toEqual({emotes:{},complete:false});
  expect(channel).toHaveBeenCalledWith('42');
 });
 it('supports official YouTube only with a caller-owned key, never anonymously',async()=>{
  const onEvent=vi.fn(),close=vi.fn();
  expect(()=>createBrowserChatSource().connect({platform:'youtube',channel:'jfKfPfyJRdk',onEvent})).toThrow(/API key/i);
  youtube.mockResolvedValue({close});
  const source=createBrowserChatSource({youtubeApiKey:'fixture-public-key'});
  const handle=source.connect({platform:'youtube',channel:'jfKfPfyJRdk',onEvent});
  expect(youtube).toHaveBeenCalledWith(expect.objectContaining({
   videoId:'jfKfPfyJRdk',apiKey:'fixture-public-key',apiKeyHeader:true,minPollMs:10000,emitInitialHistory:false,
  }));
  expect(await source.emotes('jfKfPfyJRdk','youtube')).toEqual({emotes:{},complete:true});
  handle.close();expect(close).toHaveBeenCalledOnce();
 });
 it('does not pretend an unsupported provider is direct or invoke IRC for it',async()=>{
  irc.mockClear();
  const source=createBrowserChatSource();
  for(const platform of ['tiktok'] as const){
   expect(()=>source.connect({platform,channel:'example',getEmotes:()=>({}),onEvent:vi.fn()})).toThrow(/relay/i);
   await expect(source.emotes('example',platform)).rejects.toThrow(/relay/i);
  }
  expect(irc).not.toHaveBeenCalled();
 });
});
