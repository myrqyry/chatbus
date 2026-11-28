import {describe,it,expect,vi,afterEach} from 'vitest';
import {resolveKickChannel,fetchKickUserAvatar,clearKickAvatarCache,createKickBadgeCatalog} from '../src/index';
const avatar='https://files.kick.com/images/user/7/profile_image/avatar.webp';
const badge='https://files.kick.com/channel_subscriber_badges/1/conversion/original-fullsize.png';
const payload={id:20,slug:'garden',chatroom:{id:30},user:{id:7,profile_pic:avatar},subscriber_badges:[{months:1,badge_image:{src:badge}}],livestream:null};
describe('shared Kick channel metadata',()=>{
 afterEach(()=>{clearKickAvatarCache();vi.unstubAllGlobals();vi.useRealTimers();});
 it('shares one network request across chat identity, emote identity, avatar and subscriber badges',async()=>{
  let release!:(r:Response)=>void;
  const fetcher=vi.fn(()=>new Promise<Response>(r=>{release=r}));vi.stubGlobal('fetch',fetcher);
  const catalog=createKickBadgeCatalog(undefined,null);
  const work=[resolveKickChannel('Garden'),resolveKickChannel('garden'),fetchKickUserAvatar('garden'),catalog.loadChannel('garden',()=>{})] as const;
  expect(fetcher).toHaveBeenCalledTimes(1);
  release(Response.json(payload));const [chat,emotes,image]=await Promise.all(work);
  expect(chat.chatroomId).toBe(30);expect(emotes.channelId).toBe('20');expect(image).toBe(avatar);
  expect(catalog.resolve([{provider:'kick',id:'subscriber',version:'1'}])[0]?.images[0]?.url).toBe(badge);
 });
 it('cancels callers independently and aborts shared transport only when nobody remains',async()=>{
  const calls:{signal:AbortSignal;release:(r:Response)=>void}[]=[];
  vi.stubGlobal('fetch',vi.fn((_url:string,init:RequestInit)=>new Promise<Response>((release,reject)=>{
   const signal=init.signal!;calls.push({signal,release});signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
  })));
  const a=new AbortController(),b=new AbortController();
  const first=resolveKickChannel('garden',{signal:a.signal}).catch(e=>e);
  const second=resolveKickChannel('garden',{signal:b.signal});
  a.abort();expect(await first).toMatchObject({name:'AbortError'});expect(calls).toHaveLength(1);expect(calls[0]!.signal.aborted).toBe(false);
  calls[0]!.release(Response.json(payload));expect((await second).channelId).toBe('20');
  const c=new AbortController();const third=resolveKickChannel('garden',{signal:c.signal}).catch(e=>e);c.abort();
  expect(await third).toMatchObject({name:'AbortError'});expect(calls[1]!.signal.aborted).toBe(true);
  const next=resolveKickChannel('garden');expect(calls).toHaveLength(3);calls[2]!.release(Response.json(payload));await next;
 });
 it('does not reuse completed or pre-reconnect requests for a fresh lookup',async()=>{
  const calls:((r:Response)=>void)[]=[];vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(r=>calls.push(r))));
  const old=resolveKickChannel('garden'),fresh=resolveKickChannel('garden',{fresh:true});
  expect(calls).toHaveLength(2);
  calls[1]!(Response.json({...payload,livestream:{id:101}}));expect((await fresh).raw).toMatchObject({livestream:{id:101}});
  calls[0]!(Response.json(payload));await old;
  const next=resolveKickChannel('garden');expect(calls).toHaveLength(3);calls[2]!(Response.json(payload));await next;
 });
 it('bounds streamed response size and cancels a stalled body',async()=>{
  const cancel=vi.fn();
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1_000_001));},cancel}))));
  await expect(resolveKickChannel('garden')).rejects.toThrow(/maximum size/);
  expect(cancel).toHaveBeenCalledOnce();
  vi.useFakeTimers();
  const stalled=vi.fn();
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({cancel:stalled}))));
  const result=resolveKickChannel('garden').catch(e=>e);
  await vi.advanceTimersByTimeAsync(8000);
  expect(await result).toMatchObject({name:'AbortError'});expect(stalled).toHaveBeenCalledOnce();
 });
 it('keeps callers from mutating each other’s raw metadata',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json(payload)));
  const [a,b]=await Promise.all([resolveKickChannel('garden'),resolveKickChannel('garden')]);
  (a.raw as typeof payload).user.profile_pic='changed';
  expect((b.raw as typeof payload).user.profile_pic).toBe(avatar);
 });

});
