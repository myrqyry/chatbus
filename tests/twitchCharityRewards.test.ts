import {describe,it,expect} from 'vitest';
import {normalizeTwitchEventSubNotification,parseTwitchEventSubFrame,toSocialSignal,planTwitchCapabilities} from '../src/index';
const get=(type:string,data:Record<string,unknown>)=>{
 const env=parseTwitchEventSubFrame(JSON.stringify({metadata:{message_id:'delivery',message_type:'notification',message_timestamp:'2026-11-27T12:00:00Z',subscription_type:type},payload:{event:data}}))!;
 const ev=normalizeTwitchEventSubNotification(env);return ev?toSocialSignal(ev):null;
};
const channel={broadcaster_user_id:'1',broadcaster_user_login:'garden',user_id:'2',user_login:'fox',id:'redemption'};
describe('charity and power-up evidence',()=>{
 it('uses charity campaign broadcaster_id and exact minor units, preserving target currency independently',()=>{
  expect(get('channel.charity_campaign.progress',{broadcaster_id:'1',broadcaster_login:'garden',id:'campaign',charity_name:'Example',current_amount:{value:12345,decimal_places:2,currency:'USD'},target_amount:{value:100000,decimal_places:2,currency:'USD'}})).toMatchObject({source:{channelId:'1',channelName:'garden'},event:{type:'charity'},engagement:{kind:'charity',id:'campaign',phase:'progress',title:'Example',currentMoney:{value:12345,decimalPlaces:2,currency:'USD'},targetMoney:{value:100000,decimalPlaces:2,currency:'USD'}}});
 });
 it('projects charity donations without rounding or converting currencies',()=>{
  const s=get('channel.charity_campaign.donate',{...channel,campaign_id:'c',charity_name:'Example',amount:{value:123,decimal_places:3,currency:'KWD'}});
  expect(s).toMatchObject({event:{type:'donation'},measurements:{amount:'0.123',currency:'KWD'},charityDonation:{campaignId:'c',name:'Example'}});
  expect(get('channel.charity_campaign.donate',{...channel,amount:{value:1,decimal_places:99,currency:'USD'}})?.measurements).toBeUndefined();
 });
 it('keeps points, actual Bits, and custom power-up self-redemptions distinct',()=>{
  const a=get('channel.channel_points_automatic_reward_redemption.add',{...channel,reward:{type:'send_highlighted_message',channel_points:100},message:{text:'hi'}});
  expect(a?.reward).toEqual({type:'send_highlighted_message',kind:'automatic',cost:100,input:'hi'});
  const b=get('channel.bits.use',{...channel,type:'power_up',bits:150,power_up:{type:'celebration'}});
  expect(b).toMatchObject({event:{type:'reward-redemption'},reward:{kind:'power-up',type:'celebration'},measurements:{bits:150}});
  const c=get('channel.custom_power_up_redemption.add',{...channel,user_id:'1',custom_power_up:{id:'p',title:'Spark',bits:250}});
  expect(c).toMatchObject({reward:{kind:'custom-power-up',id:'p',title:'Spark'},measurements:{bits:0}});
  expect(get('channel.bits.use',{...channel,type:'custom_power_up',bits:250})).toBeNull();
  expect(get('channel.bits.use',{...channel,type:'cheer',bits:250})).toBeNull();
 });
 it('plans charity and reward scopes with version 2 automatic rewards',()=>{
  const p=planTwitchCapabilities(['charity','automatic-rewards','power-ups'],{broadcasterUserId:'1',userId:'1',scopes:['channel:read:charity','channel:read:redemptions','bits:read']});
  expect(p.subscriptions).toHaveLength(7);expect(p.subscriptions.every(s=>s.ready)).toBe(true);
  expect(p.subscriptions.find(s=>s.type==='channel.channel_points_automatic_reward_redemption.add')?.version).toBe('2');
 });
});
