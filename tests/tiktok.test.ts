import { CommonMessageData, User, WebcastChatMessage, WebcastGiftMessage, Gift } from 'tiktok-live-connector';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createChatBus, deserializeChatEvent, serializeChatEvent, toSocialSignal } from '../src/index';
import { connectTikTokChat, createTikTokLiveDriver, normalizeTikTokEvent, normalizeTikTokChannel, type TikTokDriver } from '../src/platforms/tiktok';
const context={channel:'creator',roomId:'7260000000000000001',receivedAt:1700000001000};
const user={id:'7260000000000000002',displayId:'viewer',nickname:'Viewer'};
const common={msgId:'7260000000000000003',roomId:context.roomId,createTime:'1700000000000'};
const message={common,user,content:'Hello LOCAL'};
class Driver extends EventEmitter implements TikTokDriver {
  disconnect=vi.fn(async()=>{});
  connect=vi.fn(async()=>({isConnected:true,roomId:context.roomId}));
}
describe('TikTok LIVE read-only connector',()=>{
 it('normalizes usernames and exact string IDs and uses the shared emote parser',()=>{
  expect(normalizeTikTokChannel('https://www.tiktok.com/@Creator/live')).toBe('creator');
  expect(normalizeTikTokChannel('@Creator')).toBe('creator');
  expect(()=>normalizeTikTokChannel('https://example.com/@creator/live')).toThrow();
  const event=normalizeTikTokEvent('chat',message,{...context,emotes:{LOCAL:{id:'local',code:'LOCAL',provider:'custom',url:'https://example.com/e.png',zeroWidth:false}}})!;
  expect(event).toMatchObject({id:common.msgId,type:'message',platform:'tiktok',channelId:context.roomId,timestamp:1700000000000,user:{id:user.id,username:'viewer',displayName:'Viewer'},message:{text:'Hello LOCAL',fragments:[{type:'text',text:'Hello '},{type:'emote',emote:{id:'local'}}]}});
  expect(event.origin).toBeUndefined();
  expect(deserializeChatEvent(serializeChatEvent(event))).toEqual(event);
  expect(toSocialSignal(event,{receivedAtMs:context.receivedAt}).source.platform).toBe('tiktok');
  expect(normalizeTikTokEvent('chat',{...message,user:undefined},context)).toBeNull();
  expect(normalizeTikTokEvent('chat',{...message,common:{...common,msgId:''}},context)).toBeNull();
 });
 it('handles final gift streaks without treating diamonds as cash or subscriptions',()=>{
  const gift={common,user,giftId:'5655',repeatCount:3,repeatEnd:0,groupId:'987',gift:{type:1,name:'Rose',diamondCount:1}};
  expect(normalizeTikTokEvent('gift',gift,context)).toBeNull();
  expect(normalizeTikTokEvent('gift',{...gift,repeatEnd:1},context)).toMatchObject({type:'donation',data:{source:'tiktok-live',giftId:'5655',giftName:'Rose',count:3,diamondsPerGift:1}});
  expect(toSocialSignal(normalizeTikTokEvent('gift',{...gift,repeatEnd:1},context)!).measurements).toEqual({count:3});
  expect(normalizeTikTokEvent('follow',{common,user},context)?.type).toBe('follow');
 });

 it('consumes messages decoded by the pinned v3 protobuf implementation',async()=>{
  const source=WebcastChatMessage.decode(new Uint8Array());
  source.common={...CommonMessageData.decode(new Uint8Array()),...common};
  source.user={...User.decode(new Uint8Array()),...user};
  source.content='hello 🌱';
  const decoded=WebcastChatMessage.decode(WebcastChatMessage.encode(source).finish());
  expect(normalizeTikTokEvent('chat',decoded,context)).toMatchObject({id:common.msgId,user:{id:user.id,username:'viewer'},message:{text:'hello 🌱'}});
  const gift=WebcastGiftMessage.decode(new Uint8Array());
  gift.common=source.common;gift.user=source.user;gift.giftId='5655';gift.repeatCount=5;gift.repeatEnd=1;
  gift.gift={...Gift.decode(new Uint8Array()),id:'5655',type:1,name:'Rose',diamondCount:1};
  const decodedGift=WebcastGiftMessage.decode(WebcastGiftMessage.encode(gift).finish());
  expect(normalizeTikTokEvent('gift',decodedGift,context)).toMatchObject({type:'donation',data:{giftId:'5655',count:5,diamondsPerGift:1}});
  const actual=await createTikTokLiveDriver('creator');
  expect(actual).toMatchObject({options:{processInitialData:false,authenticateWs:false,useMobile:false}});
  await actual.disconnect();
 });

 it('bounds setup and disposes late driver creation without starting a provider',async()=>{
  vi.useFakeTimers();
  try {
    let finish!:(driver:TikTokDriver)=>void;
    const driver=new Driver(),states=vi.fn(),errors=vi.fn();
    const handle=connectTikTokChat({channel:'creator',createDriver:()=>new Promise(resolve=>{finish=resolve;}),onEvent:vi.fn(),onStateChange:states,onError:errors});
    await vi.advanceTimersByTimeAsync(25000);
    expect(states.mock.calls.map(c=>c[0])).toEqual(['connecting','error']);
    expect(errors).toHaveBeenCalledTimes(1);
    finish(driver);
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.connect).not.toHaveBeenCalled();
    expect(driver.disconnect).toHaveBeenCalledTimes(1);
    handle.close();
    expect(vi.getTimerCount()).toBe(0);
  }finally{vi.useRealTimers();}
 });

 it('uses the real bus interface, gates readiness on upstream connect and closes on stream end',async()=>{
  const driver=new Driver(),events=vi.fn(),states:string[]=[];
  const bus=createChatBus({onEvent:events,onConnectionStateChange:s=>states.push(s.state)});
  const handle=await bus.connect({platform:'tiktok',options:{channel:'@creator',createDriver:()=>driver}});
  expect(handle.target).toBe('creator');
  await vi.waitFor(()=>expect(states).toContain('connected'));
  driver.emit('chat',message);driver.emit('chat',message);
  expect(events).toHaveBeenCalledTimes(1);
  expect(events.mock.calls[0]?.[0]).toMatchObject({origin:'live',platform:'tiktok'});
  driver.emit('streamEnd',{action:3});
  await vi.waitFor(()=>expect(states.at(-1)).toBe('disconnected'));
  driver.emit('chat',{...message,common:{...common,msgId:'other'}});
  expect(events).toHaveBeenCalledTimes(2);
  expect(events.mock.calls[1]?.[0].type).toBe('stream-offline');
  handle.close();
  expect(driver.disconnect).toHaveBeenCalledTimes(1);
 });
 it('closes a late upstream handle if the attempt is cancelled during connect',async()=>{
  const driver=new Driver(),events=vi.fn(),states=vi.fn();
  let finish!:(state:{isConnected:boolean;roomId:string})=>void;
  driver.connect.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const connection=connectTikTokChat({channel:'creator',createDriver:()=>driver,onEvent:events,onStateChange:states});
  await vi.waitFor(()=>expect(driver.connect).toHaveBeenCalledTimes(1));
  connection.close();
  finish({isConnected:true,roomId:context.roomId});
  await vi.waitFor(()=>expect(driver.disconnect).toHaveBeenCalledTimes(2));
  driver.emit('chat',message);
  expect(events).not.toHaveBeenCalled();
  expect(states.mock.calls.map(c=>c[0])).toEqual(['connecting','disconnected']);
 });
 it('reports a failed connection only once and never retries signing automatically',async()=>{
  const driver=new Driver(),errors=vi.fn(),states=vi.fn();
  driver.connect.mockImplementationOnce(async()=>{driver.emit('error',{info:'signing failed',exception:Error('key rejected')});throw Error('key rejected');});
  const handle=connectTikTokChat({channel:'creator',createDriver:()=>driver,onEvent:vi.fn(),onError:errors,onStateChange:states});
  await vi.waitFor(()=>expect(errors).toHaveBeenCalledTimes(1));
  expect(states.mock.calls.map(c=>c[0])).toEqual(['connecting','error']);
  expect(driver.connect).toHaveBeenCalledTimes(1);
  handle.close();
 });
});
