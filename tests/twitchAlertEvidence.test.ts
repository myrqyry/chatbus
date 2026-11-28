import {describe,it,expect} from 'vitest';
import {normalizeTwitchEventSubNotification,parseTwitchEventSubFrame,normalizeTwitchIrcFrame,parseTwitchIrcLine,toSocialSignal} from '../src/index';
const notice=(type:string,details:Record<string,unknown>)=>{
 const frame=parseTwitchEventSubFrame(JSON.stringify({metadata:{message_id:'notice',message_type:'notification',message_timestamp:'2026-11-27T12:00:00Z',subscription_type:'channel.chat.notification'},payload:{event:{broadcaster_user_id:'1',broadcaster_user_login:'host',chatter_user_id:'2',chatter_user_login:'viewer',notice_type:type,message_id:'msg',...details}}}));
 return toSocialSignal(normalizeTwitchEventSubNotification(frame!)!);
};
const irc=(tags:string)=>toSocialSignal(normalizeTwitchIrcFrame(parseTwitchIrcLine('@id=msg;display-name=Viewer;login=viewer;user-id=2;'+tags+' :tmi.twitch.tv USERNOTICE #host')!,{channel:'host',fallbackId:'unused'})!);
describe('real Twitch alert evidence',()=>{
 it('projects the nested EventSub raid count, aggregate gifts and actual subscription tier',()=>{
  expect(notice('raid',{raid:{viewer_count:42}}).measurements).toEqual({count:42});
  expect(notice('community_sub_gift',{community_sub_gift:{total:5,sub_tier:'2000',cumulative_total:100}})).toMatchObject({event:{tier:'2'},measurements:{count:5}});
  expect(notice('resub',{resub:{sub_tier:'1000',is_prime:true}}).event.tier).toBe('Prime');
  expect(notice('sub_gift',{sub_gift:{sub_tier:'3000'}}).event.tier).toBe('3');
 });
 it('does not confuse cumulative gifts with this event, or accept invalid counts',()=>{
  expect(notice('community_sub_gift',{community_sub_gift:{cumulative_total:100}}).measurements).toBeUndefined();
  expect(notice('raid',{raid:{viewer_count:-1}}).measurements).toBeUndefined();
 });
 it('projects documented IRC tags into the same contract',()=>{
  expect(irc('msg-id=raid;msg-param-viewerCount=42').measurements).toEqual({count:42});
  expect(irc('msg-id=resub;msg-param-sub-plan=Prime').event.tier).toBe('Prime');
  expect(irc('msg-id=submysterygift;msg-param-mass-gift-count=5;msg-param-sub-plan=2000')).toMatchObject({event:{tier:'2'},measurements:{count:5}});
 });
});
