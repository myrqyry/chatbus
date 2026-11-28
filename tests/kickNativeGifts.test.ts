import {describe,it,expect,vi} from 'vitest';
import {normalizeKickEvent,parseKickPusherFrame,toSocialSignal,connectKickChat} from '../src/index';
import {createKickTransportArbiter} from '../src/platforms/kick/arbitration';
import {normalizeKickOfficialEvent} from '../src/platforms/kick/official-events';
const payload={gift_transaction_id:'tx-1',sender:{id:2,username:'fox',username_color:'#53fc18'},gift:{gift_id:'catalog-1',amount:500,name:'Rage Quit',type:'LEVEL_UP',tier:'MID',pinned_time:600},message:'Nice stream!',created_at:'2026-11-27T22:00:00Z'};
const context={channelName:'garden',channelId:'20'};
const frame=(data:unknown,event='KicksGifted')=>JSON.stringify({event,data:JSON.stringify(data)});
const normalized=(data:unknown=payload)=>{const parsed=parseKickPusherFrame(frame(data));return parsed?normalizeKickEvent(parsed,context):null;};
describe('native Kick gifts',()=>{
 it('preserves purchase identity, top-level quote and Kicks units',()=>{
  const event=normalized()!;
  expect(event).toMatchObject({id:'tx-1',type:'donation',timestamp:Date.parse(payload.created_at),user:{id:'2',username:'fox'},channelId:'20'});
  const signal=toSocialSignal(event);
  expect(signal.kickGift).toMatchObject({amount:500,name:'Rage Quit',type:'LEVEL_UP',tier:'MID',quote:'Nice stream!'});
  expect(signal.measurements?.currency).toBeUndefined();
  expect(signal.kickGift?.pinnedSeconds).toBeUndefined(); // native unit not verified
  expect(normalized({...payload,gift_transaction_id:'tx-2'})?.id).toBe('tx-2');
 });
 it('rejects malformed money-like or actor fields rather than guessing',()=>{
  for(const data of [{...payload,gift:{amount:'500'}},{...payload,gift:{amount:-1}},{...payload,sender:{}},{...payload,gift_transaction_id:''},{...payload,gift_transaction_id:undefined}])expect(normalized(data)).toBeNull();
 });
 it('recognizes the unprefixed gifted-subscriptions envelope',()=>{
  expect(parseKickPusherFrame(frame({gifter_username:'fox',gifted_usernames:['owl']},'GiftedSubscriptionsEvent'))?.type).toBe('GiftedSubscriptions');
 });
 it('coordinates optional official gifts without double-alerting',()=>{
  const arbiter=createKickTransportArbiter({channelName:'garden',nativeChannelId:'20',broadcasterId:'1'});
  const official=normalizeKickOfficialEvent('kicks.gifted',{broadcaster:{user_id:1,channel_slug:'garden'},sender:{user_id:2,username:'fox'},gift:{amount:500}},{id:'delivery',timestamp:Date.now(),broadcasterId:'1'})!;
  arbiter.setNativeConnected(true);
  expect(arbiter.accept('native',normalized()!)).not.toBeNull();
  expect(arbiter.accept('official',official)).toBeNull();
  arbiter.setOfficialCoverage(['kicks.gifted']);
  expect(arbiter.accept('native',normalized()!)).toBeNull();
  expect(arbiter.accept('official',official)).not.toBeNull();
  arbiter.setOfficialCoverage([]);arbiter.setNativeConnected(false);
  expect(arbiter.accept('official',official)).not.toBeNull();
 });
 it('subscribes the public Pusher gift topics on the existing socket and deduplicates exact transaction IDs',async()=>{
  class Socket{
   static latest:Socket;
   sent:string[]=[];onopen?:()=>void;onmessage?:(e:{data:string})=>void;onclose?:()=>void;onerror?:()=>void;
   constructor(){Socket.latest=this;}send(v:string){this.sent.push(v);}close(){this.onclose?.();}
   emit(v:string){this.onmessage?.({data:v});}
  }
  vi.stubGlobal('WebSocket',Socket);
  const events:string[]=[];
  try{
   const connection=await connectKickChat({channel:'garden',channelId:'20',chatroomId:30,socket:{appKey:'fixture'},onEvent:e=>{if(e.id)events.push(e.id);}});
   try{
    await vi.waitFor(()=>expect(Socket.latest).toBeDefined());
    const ws=Socket.latest;
    ws.emit(JSON.stringify({event:'pusher:connection_established',data:'{}'}));
    const topics=ws.sent.map(s=>JSON.parse(s).data.channel);
    expect(topics).toContain('channel_20');expect(topics).toContain('chatroom_30');
    for(const channel of topics)ws.emit(JSON.stringify({event:'pusher_internal:subscription_succeeded',channel,data:'{}'}));
    ws.emit(frame(payload));ws.emit(frame(payload));ws.emit(frame({...payload,gift_transaction_id:'tx-2'}));
    expect(events).toEqual(['tx-1','tx-2']);
   }finally{connection.close();}
  }finally{vi.unstubAllGlobals();}
 });
});
