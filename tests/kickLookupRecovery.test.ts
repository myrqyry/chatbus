import {describe,it,expect,vi} from 'vitest';
import {connectKickChat,toSocialSignal} from '../src/index';
import {HttpError} from '../src/network/fetch';
const channel={channelName:'garden',channelId:'20',chatroomId:30,raw:{livestream:null}};
const online={...channel,raw:{livestream:{id:101,channel_id:20,session_title:'Night stream'}}};
class Socket {
 static instances:Socket[]=[];sent:string[]=[];onopen?:()=>void;onmessage?:(e:{data:string})=>void;onclose?:()=>void;onerror?:()=>void;
 constructor(){Socket.instances.push(this);}send(s:string){this.sent.push(s);}close(){this.onclose?.();}
 emit(s:string){this.onmessage?.({data:s});}
 ready(){this.emit(JSON.stringify({event:'pusher:connection_established',data:'{}'}));for(const s of this.sent.slice())this.emit(JSON.stringify({event:'pusher_internal:subscription_succeeded',channel:JSON.parse(s).data.channel,data:'{}'}));}
}
describe('Kick lookup and reconnect recovery',()=>{
 it('retries transient initial failure, but not a missing channel',async()=>{
  vi.useFakeTimers();vi.stubGlobal('WebSocket',Socket);Socket.instances=[];
  const controller=new AbortController(),states:string[]=[];
  const resolve=vi.fn().mockRejectedValueOnce(new TypeError('network unavailable')).mockResolvedValueOnce(channel);
  try{
   const pending=connectKickChat({channel:'garden',resolveChannel:resolve,retryInitialLookup:true,signal:controller.signal,socket:{appKey:'fixture'},onEvent:()=>{},onStateChange:s=>states.push(s)});
   const result=pending.then(c=>({c}),error=>({error}));
   await vi.advanceTimersByTimeAsync(1500);
   const settled=await result;expect(settled).toHaveProperty('c');expect(states).toContain('reconnecting');expect(resolve).toHaveBeenCalledTimes(2);
   if('c' in settled)settled.c.close();
   const missing=vi.fn().mockRejectedValue(new HttpError(404,'fixture'));
   await expect(connectKickChat({channel:'missing',resolveChannel:missing,retryInitialLookup:true,signal:controller.signal,onEvent:()=>{}})).rejects.toMatchObject({status:404});
   expect(missing).toHaveBeenCalledTimes(1);
  }finally{controller.abort();vi.unstubAllGlobals();vi.useRealTimers();}
 });
 it('cancels retry delay on close before another lookup',async()=>{
  vi.useFakeTimers();
  const controller=new AbortController(),resolve=vi.fn().mockRejectedValue(new TypeError('network unavailable'));
  try{
   const result=connectKickChat({channel:'garden',resolveChannel:resolve,retryInitialLookup:true,signal:controller.signal,onEvent:()=>{}}).catch(e=>e);
   await vi.advanceTimersByTimeAsync(0);controller.abort();expect(await result).toMatchObject({name:'AbortError'});
   await vi.advanceTimersByTimeAsync(60000);expect(resolve).toHaveBeenCalledTimes(1);
  }finally{controller.abort();vi.useRealTimers();}
 });
 it('refreshes missed stream state on reconnect as replay and ignores a lookup racing a live transition',async()=>{
  vi.useFakeTimers();vi.stubGlobal('WebSocket',Socket);Socket.instances=[];vi.spyOn(Math,'random').mockReturnValue(.5);
  let finish!:(v:typeof channel|typeof online)=>void;
  const resolve=vi.fn().mockResolvedValueOnce(channel).mockResolvedValueOnce(online).mockImplementationOnce(()=>new Promise(r=>{finish=r}));
  const events:ReturnType<typeof toSocialSignal>[]=[];
  const c=await connectKickChat({channel:'garden',resolveChannel:resolve,socket:{appKey:'fixture'},onEvent:e=>events.push(toSocialSignal(e))});
  try{
   Socket.instances[0]!.ready();
   Socket.instances[0]!.close();await vi.advanceTimersByTimeAsync(1000);Socket.instances[1]!.ready();await vi.advanceTimersByTimeAsync(0);
   expect(events.map(s=>[s.source.origin,s.stream?.live])).toEqual([['replay',false],['replay',true]]);
   Socket.instances[1]!.close();await vi.advanceTimersByTimeAsync(1000);Socket.instances[2]!.ready();await vi.advanceTimersByTimeAsync(0);
   Socket.instances[2]!.emit(JSON.stringify({event:'App\\Events\\StopStreamBroadcast',data:{livestream:{id:101,channel_id:20}}}));
   finish(online);await vi.advanceTimersByTimeAsync(0);
   expect(events.map(s=>[s.source.origin,s.stream?.live])).toEqual([['replay',false],['replay',true],['live',false]]);
  }finally{c.close();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();}
 });
});
