import {describe,it,expect} from 'vitest';
import {normalizeTwitchEventSubNotification,parseTwitchEventSubFrame,toSocialSignal,planTwitchCapabilities} from '../src/index';
import type {TwitchNormalizeContext} from '../src/index';
const ch={broadcaster_user_id:'1',broadcaster_user_login:'garden'};
const person={user_id:'2',user_login:'fox',user_name:'Fox'};
function event(type:string,data:Record<string,unknown>,context:TwitchNormalizeContext={}){
 const env=parseTwitchEventSubFrame(JSON.stringify({metadata:{message_id:'d',message_type:'notification',message_timestamp:'2026-11-27T12:00:00Z',subscription_type:type},payload:{event:{...ch,...data}}}))!;
 return normalizeTwitchEventSubNotification(env,context);
}
const sig=(type:string,data:Record<string,unknown>,context:TwitchNormalizeContext={})=>{const e=event(type,data,context);return e?toSocialSignal(e):null;};
describe('dedicated subscription and cheer ownership',()=>{
 it('separates new subscriptions, gifted recipients, ends and resub tenure',()=>{
  expect(sig('channel.subscribe',{...person,tier:'1000',is_gift:false})).toMatchObject({event:{type:'subscription',tier:'1'},subscription:{phase:'start',gift:false}});
  expect(sig('channel.subscribe',{...person,tier:'1000',is_gift:true})?.event.type).toBe('subscription-received');
  expect(sig('channel.subscription.end',{...person,tier:'2000',is_gift:false})).toMatchObject({event:{type:'subscription-end',tier:'2'},subscription:{phase:'end',gift:false}});
  expect(sig('channel.subscription.message',{...person,tier:'1000',cumulative_months:18,streak_months:null,duration_months:3,message:{text:'hello'}})?.subscription).toEqual({phase:'resub',months:18,durationMonths:3,quote:'hello'});
 });
 it('does not attribute an anonymous gift or cheer to a user',()=>{
  expect(sig('channel.subscription.gift',{...person,is_anonymous:true,total:5,tier:'1000'})).toMatchObject({event:{type:'gift-subscription'},measurements:{count:5},subscription:{phase:'gift',anonymous:true}});
  expect(sig('channel.subscription.gift',{...person,is_anonymous:true,total:5})?.actor).toBeUndefined();
  expect(sig('channel.cheer',{...person,is_anonymous:true,bits:100,message:'Cheer100'})?.actor).toBeUndefined();
  expect(sig('channel.cheer',{is_anonymous:true,bits:100,message:'Cheer100'})).toMatchObject({event:{type:'cheer'},measurements:{bits:100},cheer:{anonymous:true,quote:'Cheer100'}});
 });
 it('retains chat fallback and suppresses only overlap with active confirmed subscription',()=>{
  const notice={chatter_user_id:'2',chatter_user_login:'fox',message_id:'m',notice_type:'sub',sub:{sub_tier:'1000',is_prime:true},message:{text:'hello'}};
  expect(sig('channel.chat.notification',notice)?.event).toMatchObject({type:'subscription',tier:'Prime'});
  expect(event('channel.chat.notification',notice,{activeSubscriptions:new Set(['channel.subscribe'])})).toMatchObject({type:'message',message:{id:'m',text:'hello'}});
  expect(sig('channel.chat.notification',{...notice,notice_type:'shared_chat_sub'},{activeSubscriptions:new Set(['channel.subscribe'])})?.event.type).toBe('subscription');
  const gift={...notice,notice_type:'sub_gift',sub_gift:{sub_tier:'1000',community_gift_id:'batch'}};
  expect(sig('channel.chat.notification',gift)?.event.type).not.toBe('gift-subscription');
  expect(sig('channel.chat.notification',{...gift,sub_gift:{sub_tier:'1000'}})?.measurements?.count).toBe(1);
 });
 it('keeps reward status changes separate from redemption alerts',()=>{
  expect(sig('channel.channel_points_custom_reward_redemption.update',{...person,id:'r',status:'fulfilled',reward:{id:'reward',title:'Song',cost:100}})).toMatchObject({event:{type:'reward-update'},reward:{id:'reward',title:'Song',status:'fulfilled',redemptionId:'r'}});
  expect(sig('channel.channel_points_custom_reward.add',{id:'reward',title:'Song',cost:100,is_enabled:true})).toMatchObject({event:{type:'reward-catalog'},reward:{id:'reward',title:'Song',cost:100,status:'added',enabled:true}});
 });
 it('plans dedicated scopes',()=>{
  const p=planTwitchCapabilities(['subscriptions','cheers','reward-lifecycle'],{broadcasterUserId:'1',userId:'1',scopes:['channel:read:subscriptions','bits:read','channel:read:redemptions']});
  expect(p.subscriptions).toHaveLength(9);expect(p.subscriptions.every(s=>s.ready)).toBe(true);
 });
});
