import {describe,it,expect} from 'vitest';
import {normalizeTwitchEventSubNotification,parseTwitchEventSubFrame,toSocialSignal,planTwitchCapabilities} from '../src/index';
const channel={broadcaster_user_id:'1',broadcaster_user_login:'garden'};
function signal(type:string,event:Record<string,unknown>){
 const env=parseTwitchEventSubFrame(JSON.stringify({metadata:{message_id:'delivery',message_type:'notification',message_timestamp:'2026-11-27T12:00:00Z',subscription_type:type},payload:{event:{...channel,...event}}}))!;
 const normalized=normalizeTwitchEventSubNotification(env);return normalized?toSocialSignal(normalized):null;
}
describe('broadcast notices',()=>{
 it('distinguishes incoming and outgoing shoutouts and preserves reported audience',()=>{
  expect(signal('channel.shoutout.receive',{from_broadcaster_user_id:'2',from_broadcaster_user_login:'fox',viewer_count:43})).toMatchObject({event:{type:'shoutout'},actor:{id:'2',username:'fox'},shoutout:{direction:'received',channelId:'2',channelName:'fox'},measurements:{count:43}});
  expect(signal('channel.shoutout.create',{to_broadcaster_user_id:'3',to_broadcaster_user_login:'owl',viewer_count:12,moderator_user_login:'mod'})).toMatchObject({event:{type:'shoutout'},shoutout:{direction:'sent',channelId:'3',channelName:'owl'},measurements:{count:12}});
 });
 it('retains ad start/duration, not invented actual viewer exposure',()=>{
  expect(signal('channel.ad_break.begin',{duration_seconds:90,started_at:'2026-11-27T12:00:00Z',is_automatic:false})).toMatchObject({event:{type:'ad-break'},adBreak:{durationSeconds:90,startedAtMs:Date.parse('2026-11-27T12:00:00Z'),automatic:false}});
  expect(signal('channel.ad_break.begin',{duration_seconds:-1,started_at:'bad'})?.adBreak).toEqual({});
 });
 it('plans read-only scopes and moderator conditions',()=>{
  const plan=planTwitchCapabilities(['shoutouts','ads'],{broadcasterUserId:'1',userId:'1',scopes:['moderator:read:shoutouts','channel:read:ads']});
  expect(plan.subscriptions).toHaveLength(3);
  expect(plan.subscriptions.every(s=>s.ready)).toBe(true);
  expect(plan.subscriptions.find(s=>s.type==='channel.shoutout.receive')?.conditionValues).toEqual({broadcaster_user_id:'1',moderator_user_id:'1'});
 });
});
