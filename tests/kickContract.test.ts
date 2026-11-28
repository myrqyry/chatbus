import {describe,it,expect,vi} from 'vitest';
import {generateKeyPairSync} from 'node:crypto';
import {fetchKickWebhookPublicKey} from '../src/platforms/kick/webhook';
import {normalizeKickOfficialEvent,toSocialSignal} from '../src/index';
import {reconcileKickWebhookSubscriptions} from '../src/platforms/kick/subscriptions';
const {publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const pem=publicKey.export({type:'spki',format:'pem'}).toString();
const broadcaster={user_id:1,channel_slug:'garden'},actor={user_id:2,username:'fox'};
const created='2026-11-27T22:00:00Z',expires='2026-12-27T22:00:00Z';
const at=Date.parse(created),delivery={id:'delivery',timestamp:at+5000,broadcasterId:'1'};
const event=(type:string,fields:Record<string,unknown>)=>normalizeKickOfficialEvent(type,{broadcaster,...fields},delivery)!;
describe('Kick official contract gaps',()=>{
 it('accepts JSON and raw PEM and rejects non-RSA/malformed/failed key responses',async()=>{
  for(const body of [JSON.stringify({data:{public_key:pem}}),pem]){
   expect(await fetchKickWebhookPublicKey(async()=>new Response(body))).toBe(pem.trim());
  }
  const ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'pem'}).toString();
  for(const r of [new Response(ec),new Response('-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----'),new Response(pem,{status:503}),new Response('x'.repeat(20000))]){
   await expect(fetchKickWebhookPublicKey(async()=>r)).rejects.toThrow();
  }
 });
 it('preserves subscription expiration without mislabeling duration as cumulative tenure',()=>{
  const e=event('channel.subscription.renewal',{subscriber:actor,duration:3,created_at:created,expires_at:expires});
  expect(e.timestamp).toBe(at);
  expect(toSocialSignal(e).subscription).toEqual({phase:'resub',durationMonths:3,expiresAtMs:Date.parse(expires)});
  expect(toSocialSignal(event('channel.subscription.gifts',{gifter:{is_anonymous:true,user_id:null,username:null},giftees:[actor],created_at:created,expires_at:expires})).subscription).toMatchObject({phase:'gift',anonymous:true,expiresAtMs:Date.parse(expires)});
 });
 it('preserves redemption time separately from update delivery time and reward description',()=>{
  const e=event('channel.reward.redemption.updated',{id:'redemption',status:'accepted',redeemer:actor,redeemed_at:created,reward:{id:'reward',title:'Song',cost:100,description:'Choose a song'}});
  expect(e.timestamp).toBe(delivery.timestamp);
  expect(toSocialSignal(e).reward).toMatchObject({redeemedAtMs:at,description:'Choose a song',status:'accepted'});
 });
 it('preserves parent text and identity, with emote positions as source evidence',()=>{
  const e=event('chat.message.sent',{sender:actor,message_id:'child',content:'Hi [emote:37226:KEKW]',created_at:created,replies_to:{message_id:'parent',content:'original',sender:{user_id:3,username:'owl'}},emotes:[{emote_id:'37226',positions:[{s:3,e:20}]}]});
  expect(e.message?.reply).toEqual({parentMessageId:'parent',parentMessageBody:'original',parentUserId:'3',parentUsername:'owl',parentDisplayName:'owl'});
  expect(e.data).toMatchObject({nativeEmotes:[{id:'37226',positions:[{start:3,end:20}]}]});
  expect(e.message?.fragments).toContainEqual(expect.objectContaining({type:'emote',text:'KEKW'}));
 });
 it('preserves stream/category and moderation evidence without putting moderation reasons on the public signal',()=>{
  const e=event('livestream.metadata.updated',{metadata:{title:'Stream',language:'en',has_mature_content:false,category:{id:42,name:'Art',thumbnail:'https://example.com/art.png'}}});
  expect(e.data).toMatchObject({title:'Stream',language:'en',hasMatureContent:false,category:'Art',categoryId:'42',categoryThumbnail:'https://example.com/art.png'});
  const ban=event('moderation.banned',{moderator:{user_id:3,username:'mod'},banned_user:actor,metadata:{reason:'spam',created_at:created,expires_at:null}});
  expect(ban).toMatchObject({type:'user-ban',timestamp:at,data:{reason:'spam',createdAt:created,expiresAt:null,bannedBy:{id:'3',username:'mod'}}});
  expect(JSON.stringify(toSocialSignal(ban))).not.toContain('spam');
 });
 it('reconciles missing subscriptions using authoritative readback, does not delete or claim rejected ones',async()=>{
  const sub=(event:string,id:string,broadcaster_user_id=1)=>({event,id,broadcaster_user_id,method:'webhook',version:1});
  const fetcher=vi.fn<typeof fetch>()
   .mockResolvedValueOnce(Response.json({data:[sub('channel.followed','existing'),sub('chat.message.sent','unrelated',2)]}))
   .mockResolvedValueOnce(Response.json({data:[{name:'chat.message.sent',version:1,subscription_id:'created'},{name:'kicks.gifted',version:1,error:'denied'}]}))
   .mockResolvedValueOnce(Response.json({data:[sub('channel.followed','existing'),sub('chat.message.sent','created')]}));
  const r=await reconcileKickWebhookSubscriptions({appAccessToken:'fixture-token',broadcasterId:'1',events:['channel.followed','chat.message.sent','kicks.gifted'],fetcher});
  expect(r.active.map(x=>x.id)).toEqual(['existing','created']);
  expect(r.created.map(x=>x.id)).toEqual(['created']);
  expect(r.missing).toEqual(['kicks.gifted']);
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({broadcaster_user_id:1,method:'webhook',events:[{name:'chat.message.sent',version:1},{name:'kicks.gifted',version:1}]});
  expect(fetcher.mock.calls.map(x=>x[1]?.method??'GET')).toEqual(['GET','POST','GET']);
 });
 it('does not provision already-active events or mutate after a failed inventory read',async()=>{
  const request={appAccessToken:'fixture-token',broadcasterId:'1',events:['channel.followed'] as const};
  const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({data:[{id:'already',event:'channel.followed',broadcaster_user_id:1,method:'webhook',version:1}]}));
  expect(await reconcileKickWebhookSubscriptions({...request,fetcher})).toMatchObject({active:[{id:'already'}],missing:[]});
  expect(fetcher).toHaveBeenCalledTimes(1);
  const denied=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('',{status:403}));
  await expect(reconcileKickWebhookSubscriptions({...request,fetcher:denied})).rejects.toThrow('403');
  expect(denied).toHaveBeenCalledTimes(1);
 });

});
