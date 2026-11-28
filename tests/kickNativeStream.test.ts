import {describe,it,expect,vi} from 'vitest';
import {normalizeKickEvent,parseKickPusherFrame,toSocialSignal,connectKickChat} from '../src/index';
import {createKickTransportArbiter} from '../src/platforms/kick/arbitration';
import {normalizeKickOfficialEvent} from '../src/platforms/kick/official-events';
const ctx={channelName:'garden',channelId:'20',now:()=>1000};
const start={livestream:{id:101,channel_id:20,session_title:'Night stream',created_at:'2026-11-28T00:00:00Z'}};
const stop={livestream:{id:101,channel:{id:20}}};
const frame=(name:string,data:unknown)=>JSON.stringify({event:'App\\Events\\'+name,data:JSON.stringify(data)});
const normalize=(name:string,data:unknown)=>{const p=parseKickPusherFrame(frame(name,data));return p?normalizeKickEvent(p,ctx):null;};
describe('native stream lifecycle',()=>{
 it('projects bounded lifecycle evidence without treating the start time as the event receipt or fabricating end time',()=>{
  const e=normalize('StreamerIsLive',start)!;
  expect(e.type).toBe('stream-online');expect(e.timestamp).toBe(1000);
  expect(toSocialSignal(e).stream).toEqual({live:true,id:'101',title:'Night stream'});
  expect(toSocialSignal(normalize('StopStreamBroadcast',stop)!).stream).toEqual({live:false,id:'101'});
  expect(normalize('StreamerIsLive',{livestream:{...start.livestream,channel_id:21}})).toBeNull();
  expect(normalize('StopStreamBroadcast',{livestream:{id:101,channel:{id:21}}})).toBeNull();
  expect(normalize('StreamerIsLive',{})).toBeNull();
 });
 it('does not emit synthetic transitions from socket state; dedups identical stream transitions and rejects old stops',async()=>{
  class Socket {
   static latest:Socket;sent:string[]=[];onopen?:()=>void;onmessage?:(e:{data:string})=>void;onclose?:()=>void;onerror?:()=>void;
   constructor(){Socket.latest=this;}send(s:string){this.sent.push(s);}close(){this.onclose?.();}emit(s:string){this.onmessage?.({data:s});}
  }
  vi.stubGlobal('WebSocket',Socket);
  const events:ReturnType<typeof toSocialSignal>[]=[];
  try{
   const connection=await connectKickChat({channel:'garden',resolveChannel:async()=>({channelName:'garden',channelId:'20',chatroomId:30,raw:{livestream:null}}),socket:{appKey:'fixture'},onEvent:e=>events.push(toSocialSignal(e))});
   try{
    await vi.waitFor(()=>expect(Socket.latest).toBeDefined());
    const ws=Socket.latest;
    ws.emit(JSON.stringify({event:'pusher:connection_established',data:'{}'}));
    for(const s of ws.sent)ws.emit(JSON.stringify({event:'pusher_internal:subscription_succeeded',channel:JSON.parse(s).data.channel,data:'{}'}));
    expect(events.map(e=>[e.source.origin,e.stream?.live])).toEqual([['replay',false]]);
    ws.emit(frame('StreamerIsLive',start));ws.emit(frame('StreamerIsLive',start));
    ws.emit(frame('StreamerIsLive',{livestream:{...start.livestream,id:102}}));ws.emit(frame('StopStreamBroadcast',stop));
    ws.emit(frame('StopStreamBroadcast',{livestream:{id:102,channel:{id:20}}}));
    expect(events.map(e=>[e.source.origin,e.stream?.live,e.stream?.id])).toEqual([['replay',false,undefined],['live',true,'101'],['live',true,'102'],['live',false,'102']]);
   }finally{connection.close();}
  }finally{vi.unstubAllGlobals();}
 });
 it('keeps native lifecycle as preferred source unless official coverage is confirmed',()=>{
  const a=createKickTransportArbiter({channelName:'garden',nativeChannelId:'20',broadcasterId:'1'});
  const official=normalizeKickOfficialEvent('livestream.status.updated',{broadcaster:{user_id:1,channel_slug:'garden'},is_live:true,title:'Night stream'},{id:'d',timestamp:1000,broadcasterId:'1'})!;
  a.setNativeConnected(true);expect(a.accept('official',official)).toBeNull();expect(a.accept('native',normalize('StreamerIsLive',start)!)).not.toBeNull();
  a.setOfficialCoverage(['livestream.status.updated']);expect(a.accept('native',normalize('StreamerIsLive',start)!)).toBeNull();expect(a.accept('official',official)).not.toBeNull();
 });
});
