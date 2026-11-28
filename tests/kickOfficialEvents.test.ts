import {describe,it,expect} from 'vitest';
import {generateKeyPairSync,sign} from 'node:crypto';
import {createKickWebhookReceiver} from '../src/platforms/kick/webhook';
import {toSocialSignal,normalizeKickEvent} from '../src/index';
import type {ChatEvent} from '../src/types/chat';
const now=Date.parse('2026-11-27T22:00:00Z'),timestamp=new Date(now).toISOString();
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const broadcaster={user_id:1,username:'Garden',channel_slug:'garden'};
const actor={user_id:2,username:'fox'};
const fixtures:Record<string,Record<string,unknown>>={
 'channel.followed':{broadcaster,follower:actor},
 'channel.subscription.new':{broadcaster,subscriber:actor,duration:1,created_at:timestamp},
 'channel.subscription.renewal':{broadcaster,subscriber:actor,duration:3,created_at:timestamp},
 'channel.subscription.gifts':{broadcaster,gifter:{is_anonymous:true,...actor},giftees:[actor,{user_id:3,username:'owl'}]},
 'channel.reward.redemption.updated':{broadcaster,id:'reward-redemption-id',redeemer:actor,reward:{id:'reward-id',title:'Song',cost:500},status:'pending',user_input:'Hello'},
 'kicks.gifted':{broadcaster,sender:actor,gift:{amount:500,name:'Rage Quit',type:'LEVEL_UP',tier:'MID',message:'hi',pinned_time_seconds:600}},
 'livestream.status.updated':{broadcaster,is_live:true,title:'Live'},
 'livestream.metadata.updated':{broadcaster,metadata:{title:'New title'}},
 'moderation.banned':{broadcaster,banned_user:actor,metadata:{banned_at:timestamp,expires_at:'2026-11-27T23:00:00Z'}},
 'chat.message.sent':{broadcaster,sender:{...actor,identity:{username_color:'#53fc18',badges:[{type:'moderator',text:'Moderator'}]}},content:'Hello [emote:37226:KEKW]',message_id:'chat-id',replies_to:{message_id:'parent'},created_at:timestamp}
};
const frame=(type:string,body:Record<string,unknown>,id='delivery-1',time=timestamp)=>{
 const bytes=Buffer.from(JSON.stringify(body)),signature=sign('RSA-SHA256',Buffer.concat([Buffer.from(id+'.'+time+'.'),bytes]),privateKey).toString('base64');
 return {body:bytes,headers:{'kick-event-message-id':id,'kick-event-message-timestamp':time,'kick-event-type':type,'kick-event-version':'1','kick-event-subscription-id':'sub-'+type,'kick-event-signature':signature}};
};
const receiver=(events:ChatEvent[])=>createKickWebhookReceiver({now:()=>now,getPublicKey:async()=>publicKey,resolveSubscription:id=>id.startsWith('sub-')?{type:id.slice(4),version:'1',broadcasterId:'1'}:undefined,onEvent:e=>{events.push(e)}});
describe('official Kick webhook intake',()=>{
 it('normalizes all documented v1 event families, preserving units and anonymous identities',async()=>{
  const events:ChatEvent[]=[],r=receiver(events);
  for(const [type,body] of Object.entries(fixtures))expect(await r.receive(frame(type,body,type.replaceAll('.','-')))).toBe('accepted');
  const signals=events.map(e=>toSocialSignal(e));
  expect(signals.map(s=>s.event.type)).toEqual(['follow','subscription','subscription','gift-subscription','reward-redemption','donation','stream-online','channel-update','user-timeout','message']);
  expect(signals[2]?.subscription).toEqual({phase:'resub',durationMonths:3});
  expect(signals[3]).toMatchObject({subscription:{phase:'gift',anonymous:true},measurements:{count:2}});
  expect(signals[3]?.actor).toBeUndefined();
  expect(signals[4]?.reward).toMatchObject({id:'reward-id',status:'pending',cost:500,input:'Hello',redemptionId:'reward-redemption-id'});
  expect(signals[5]?.kickGift).toEqual({amount:500,name:'Rage Quit',type:'LEVEL_UP',tier:'MID',quote:'hi',pinnedSeconds:600});
  expect(signals[5]?.measurements?.bits).toBeUndefined();
  expect(signals[5]?.measurements?.currency).toBeUndefined();
  expect(events[9]?.message).toMatchObject({id:'chat-id',text:'Hello KEKW',replyToMessageId:'parent',user:{color:'#53fc18',roles:['moderator']}});
 });
 it('rejects altered raw bytes, wrong subscription binding, replay timestamps, and duplicate concurrent deliveries',async()=>{
  const events:ChatEvent[]=[],r=receiver(events),f=frame('channel.followed',fixtures['channel.followed']!);
  expect(await r.receive({...f,body:Buffer.concat([f.body,Buffer.from(' ')])})).toBe('invalid');
  expect(await r.receive({...f,headers:{...f.headers,'kick-event-type':'channel.subscription.new'}})).toBe('invalid');
  expect(await r.receive(frame('channel.followed',{...fixtures['channel.followed'],broadcaster:{...broadcaster,user_id:8}},'wrong'))).toBe('invalid');
  expect(await r.receive(frame('channel.followed',fixtures['channel.followed']!,'old',new Date(now-600001).toISOString()))).toBe('invalid');
  expect((await Promise.all([r.receive(f),r.receive(f)])).sort()).toEqual(['accepted','unavailable']);
  expect(await r.receive(f)).toBe('duplicate');
  expect(events).toHaveLength(1);
 });
 it('retains accurate gift counts from the existing anonymous browser transport',()=>{
  const e=normalizeKickEvent({type:'GiftedSubscriptions',data:{gifter_username:'fox',gifted_usernames:['a','b','c']}})!;
  expect(toSocialSignal(e)).toMatchObject({event:{type:'gift-subscription'},measurements:{count:3},subscription:{phase:'gift'}});
 });
});
