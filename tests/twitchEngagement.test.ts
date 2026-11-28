import {describe,it,expect} from 'vitest';
import {normalizeTwitchEventSubNotification,parseTwitchEventSubFrame,toSocialSignal,planTwitchCapabilities,twitchSubscriptionMissingScopeRequirements} from '../src/index';
const signal=(type:string,data:Record<string,unknown>)=> {
 const env=parseTwitchEventSubFrame(JSON.stringify({metadata:{message_id:'delivery',message_type:'notification',message_timestamp:'2026-11-27T12:00:00Z',subscription_type:type},payload:{event:{id:'activity',broadcaster_user_id:'1',broadcaster_user_login:'garden',...data}}}))!;
 const event=normalizeTwitchEventSubNotification(env);
 return event?toSocialSignal(event):null;
};
describe('Twitch engagement evidence',()=>{
 it('projects poll choice totals without double counting paid votes or inventing missing totals',()=>{
  const result=signal('channel.poll.progress',{title:'Choose',choices:[{id:'a',title:'A',votes:7,channel_points_votes:2},{id:'b',title:'B'}],ends_at:'2026-11-27T12:05:00Z'});
  expect(result).toMatchObject({event:{type:'poll',id:'delivery'},engagement:{kind:'poll',id:'activity',phase:'progress',title:'Choose',choices:[{id:'a',title:'A',votes:7},{id:'b',title:'B'}]}});
  expect(result?.engagement?.expiresAtMs).toBe(Date.parse('2026-11-27T12:05:00Z'));
 });
 it('keeps prediction points and participants separate; preserves cancellation and winner only when supplied',()=>{
  const result=signal('channel.prediction.end',{title:'Win?',status:'resolved',winning_outcome_id:'a',outcomes:[{id:'a',title:'Yes',users:3,channel_points:500,top_predictors:[{user_name:'private'}]}]});
  expect(result?.engagement).toMatchObject({kind:'prediction',phase:'end',status:'resolved',winnerId:'a',choices:[{id:'a',title:'Yes',users:3,points:500}]});
  expect(JSON.stringify(result)).not.toContain('private');
  expect(signal('channel.prediction.lock',{title:'Win?',outcomes:[]})?.engagement?.phase).toBe('lock');
 });
 it('preserves goal current/target and explicit achievement, including downward progress',()=>{
  expect(signal('channel.goal.end',{type:'follower',description:'Community',current_amount:99,target_amount:100,is_achieved:false})?.engagement).toMatchObject({kind:'goal',phase:'end',goalType:'follower',current:99,target:100,achieved:false});
 });
 it('plans ten subscriptions with scoped read access',()=>{
  const plan=planTwitchCapabilities(['polls','predictions','goals'],{broadcasterUserId:'1',userId:'1',scopes:['channel:read:polls','channel:read:predictions','channel:read:goals']});
  expect(plan.subscriptions).toHaveLength(10);expect(plan.subscriptions.every(s=>s.ready&&s.handledByChatbus)).toBe(true);
  expect(twitchSubscriptionMissingScopeRequirements(['channel.poll.begin'],[])).toEqual([['channel:read:polls','channel:manage:polls']]);
 });
});
