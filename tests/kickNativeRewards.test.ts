import {describe,it,expect,vi} from 'vitest';
import {connectKickChat,normalizeKickEvent,parseKickPusherFrame,toSocialSignal} from '../src/index';
import {createKickTransportArbiter} from '../src/platforms/kick/arbitration';
import {normalizeKickOfficialEvent} from '../src/platforms/kick/official-events';
import type {ChatEvent} from '../src/types/chat';
const ctx={channelName:'garden',channelId:'20',now:()=>1000};
const payload={reward_id:'Reward-AbC',reward_title:'Thunder',user_id:7,channel_id:20,username:'fox',user_input:'now',reward_background_color:'#ffffff'};
const frame=(data:unknown,event='RewardRedeemedEvent')=>JSON.stringify({event,data:JSON.stringify(data)});
const normalized=(data:unknown=payload,event?:string)=>{const p=parseKickPusherFrame(frame(data,event));return p?normalizeKickEvent(p,ctx):null;};
describe('native Kick redemptions',()=>{
 it('reads flat and nested reward metadata, without confusing a reward ID with a redemption ID',()=>{
  const event=normalized()!;
  expect(event).toMatchObject({type:'reward-redemption',channelId:'20',user:{id:'7',username:'fox'}});
  expect(event.id).toBeUndefined();
  expect(toSocialSignal(event).reward).toEqual({id:'Reward-AbC',title:'Thunder',input:'now'});
  const nested=normalized({...payload,reward_id:undefined,reward_title:undefined,reward:{id:'Other',title:'Song',cost:50}},'App\\Events\\RewardRedeemedEvent')!;
  expect(toSocialSignal(nested).reward).toMatchObject({id:'Other',title:'Song',cost:50});
  expect(normalized({...payload,reward_id:undefined})?.id).toBeUndefined();
  expect(toSocialSignal(normalized({...payload,reward_id:undefined})!).reward?.id).toBeUndefined();
 });
 it('rejects invalid actor, title and foreign channel, never accepts ordinary chat as reward',()=>{
  for(const data of [{...payload,user_id:undefined},{...payload,user_id:0},{...payload,username:''},{...payload,reward_title:''},{...payload,channel_id:21},{...payload,reward:{id:'Different',title:'Thunder'}}])expect(normalized(data)).toBeNull();
  expect(normalized(payload,'App\\Events\\ChatMessageEvent')).toBeNull();
 });
 it('preserves repeated ID-less native purchases, dedups explicit IDs, coordinates official ownership',async()=>{
  class Socket {
   static latest:Socket;
   sent:string[]=[];onopen?:()=>void;onmessage?:(e:{data:string})=>void;onclose?:()=>void;onerror?:()=>void;
   constructor(){Socket.latest=this;}send(s:string){this.sent.push(s);}close(){this.onclose?.();}
   emit(s:string){this.onmessage?.({data:s});}
  }
  vi.stubGlobal('WebSocket',Socket);
  const events:ChatEvent[]=[];
  try{
   const connection=await connectKickChat({channel:'garden',channelId:'20',chatroomId:30,socket:{appKey:'fixture'},onEvent:e=>events.push(e)});
   try{
    await vi.waitFor(()=>expect(Socket.latest).toBeDefined());
    const ws=Socket.latest;
    ws.emit(JSON.stringify({event:'pusher:connection_established',data:'{}'}));
    for(const s of ws.sent)ws.emit(JSON.stringify({event:'pusher_internal:subscription_succeeded',channel:JSON.parse(s).data.channel,data:'{}'}));
    ws.emit(frame(payload));ws.emit(frame(payload));
    ws.emit(frame({...payload,redemption_id:'redemption-1'}));ws.emit(frame({...payload,redemption_id:'redemption-1'}));
    expect(events.map(e=>e.id)).toEqual([undefined,undefined,'redemption-1']);
   }finally{connection.close();}
  }finally{vi.unstubAllGlobals();}
  const arbiter=createKickTransportArbiter({channelName:'garden',nativeChannelId:'20',broadcasterId:'1'});
  const official=normalizeKickOfficialEvent('channel.reward.redemption.updated',{broadcaster:{user_id:1,channel_slug:'garden'},redeemer:{user_id:7,username:'fox'},reward:{id:'Reward-AbC',title:'Thunder'},id:'redemption-1',status:'pending'},{id:'delivery',timestamp:1000,broadcasterId:'1'})!;
  arbiter.setNativeConnected(true);
  expect(arbiter.accept('native',normalized()!)).not.toBeNull();
  expect(arbiter.accept('official',official)).toBeNull();
  arbiter.setOfficialCoverage(['channel.reward.redemption.updated']);
  expect(arbiter.accept('native',normalized()!)).toBeNull();
  expect(arbiter.accept('official',official)).not.toBeNull();
  arbiter.setOfficialCoverage([]);arbiter.setNativeConnected(false);
  expect(arbiter.accept('official',official)).not.toBeNull();
 });
});
