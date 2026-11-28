import {describe,it,expect} from 'vitest';
import {createKickTransportArbiter} from '../src/platforms/kick/arbitration';
import {normalizeKickEvent} from '../src/platforms/kick/normalize';
import {normalizeKickOfficialEvent} from '../src/platforms/kick/official-events';
const now=100000,actor={user_id:2,username:'fox'},broadcaster={user_id:1,channel_slug:'garden'};
const ctx={channelId:'20',channelName:'garden',now:()=>now};
const native=(type:'Subscription'|'GiftedSubscriptions',username='fox')=>type==='Subscription'?normalizeKickEvent({type,data:{username,months:1}},ctx)!:normalizeKickEvent({type,data:{gifter_username:username,gifted_usernames:['a','b']}},ctx)!;
const official=(type:string,fields:Record<string,unknown>,id='delivery')=>normalizeKickOfficialEvent(type,{broadcaster,...fields},{id,timestamp:now,broadcasterId:'1'})!;
const sub=()=>official('channel.subscription.new',{subscriber:actor,duration:1});
const gift=()=>official('channel.subscription.gifts',{gifter:actor,giftees:[{user_id:3},{user_id:4}]});
const chat=(id:string)=>normalizeKickEvent({type:'ChatMessage',data:{id,chatroom_id:3,content:'same text',created_at:new Date(now).toISOString(),sender:{id:2,username:'fox'}}},ctx)!;
const hookChat=(id:string)=>official('chat.message.sent',{sender:actor,message_id:id,content:'same text',created_at:new Date(now).toISOString()},'delivery-'+id);
const make=()=>createKickTransportArbiter({channelName:'garden',broadcasterId:'1',nativeChannelId:'20',now:()=>now});
describe('Kick transport ownership',()=>{
 it('keeps native subscriptions until BOTH official subscription types are healthy, then falls back on loss',()=>{
  const a=make();a.setNativeConnected(true);
  expect(a.accept('native',native('Subscription'))).not.toBeNull();
  expect(a.accept('official',sub())).toBeNull();
  a.setOfficialCoverage(['channel.subscription.new']);
  expect(a.accept('native',native('Subscription'))).not.toBeNull();
  a.setOfficialCoverage(['channel.subscription.new','channel.subscription.renewal']);
  expect(a.accept('native',native('Subscription'))).toBeNull();
  expect(a.accept('official',sub())?.channelId).toBe('20');
  a.setOfficialCoverage([]);
  expect(a.accept('native',native('Subscription'))).not.toBeNull();
 });
 it('owns gifts independently, preserves legitimate repeated purchases, accepts unique official events',()=>{
  const a=make();a.setNativeConnected(true);a.setOfficialCoverage(['channel.subscription.gifts']);
  expect(a.accept('native',native('GiftedSubscriptions'))).toBeNull();
  expect(a.accept('official',gift())).not.toBeNull();
  expect(a.accept('official',gift())).not.toBeNull(); // delivery IDs dedup at ingress, no fuzzy suppression here
  expect(a.accept('native',native('Subscription'))).not.toBeNull();
  expect(a.accept('official',official('channel.followed',{follower:actor}))).not.toBeNull();
 });
 it('retains native chat richness, dedups exact message IDs during transport transitions, not message text',()=>{
  const a=make();a.setNativeConnected(true);
  expect(a.accept('native',chat('a'))).not.toBeNull();
  expect(a.accept('official',hookChat('a'))).toBeNull();
  a.setNativeConnected(false);
  expect(a.accept('official',hookChat('a'))).toBeNull();
  const b=a.accept('official',hookChat('b'));expect(b?.message?.channelId).toBe('20');
  a.setNativeConnected(true);
  expect(a.accept('native',chat('b'))).toBeNull();
  expect(a.accept('native',chat('c'))).not.toBeNull();
 });
 it('does not conflate native channel ID and official broadcaster ID, or accept another channel',()=>{
  const a=make();a.setNativeConnected(true);
  expect(a.accept('official',{...gift(),channelId:'20'})).toBeNull();
  expect(a.accept('official',{...gift(),channelName:'other'})).toBeNull();
  expect(a.accept('native',{...chat('x'),channelId:'1'})).toBeNull();
  expect(a.accept('native',{...chat('x'),channelName:'other'})).toBeNull();
 });
});
