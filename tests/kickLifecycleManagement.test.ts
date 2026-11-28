import {describe,it,expect,vi} from 'vitest';
import {generateKeyPairSync,sign} from 'node:crypto';
import {createKickWebhookReceiver,createKickWebhookKeyCache} from '../src/platforms/kick/webhook';
import {removeKickWebhookSubscriptions} from '../src/platforms/kick/subscriptions';
const pair=()=>generateKeyPairSync('rsa',{modulusLength:2048});
const a=pair(),b=pair();
const start=Date.parse('2026-11-27T22:00:00Z');
const sub=(id:string,broadcaster_user_id=1)=>({id,broadcaster_user_id,event:'channel.followed',method:'webhook',version:1});
describe('Kick webhook lifecycle',()=>{
 it('only removes explicit IDs belonging to the specified broadcaster and verifies readback',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({data:[sub('a'),sub('b'),sub('foreign',2)]})).mockResolvedValueOnce(new Response(null,{status:204})).mockResolvedValueOnce(Response.json({data:[sub('b'),sub('foreign',2)]}));
  const r=await removeKickWebhookSubscriptions({appAccessToken:'fixture',broadcasterId:'1',ids:['a','foreign','missing','a'],fetcher});
  expect(r).toEqual({removed:['a'],notOwned:['foreign','missing'],remaining:[]});
  expect(fetcher.mock.calls.map(x=>x[1]?.method)).toEqual(['GET','DELETE','GET']);
  expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.getAll('id')).toEqual(['a']);
 });
 it('does not claim removal if the provider still lists the ID',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({data:[sub('a')]})).mockResolvedValueOnce(new Response(null,{status:204})).mockResolvedValueOnce(Response.json({data:[sub('a')]}));
  expect(await removeKickWebhookSubscriptions({appAccessToken:'fixture',broadcasterId:'1',ids:['a'],fetcher})).toEqual({removed:[],notOwned:[],remaining:['a']});
 });
 it('does not delete without inventory ownership',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({data:[sub('foreign',2)]}));
  expect(await removeKickWebhookSubscriptions({appAccessToken:'fixture',broadcasterId:'1',ids:['foreign'],fetcher})).toEqual({removed:[],notOwned:['foreign'],remaining:[]});
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('coalesces cold fetches, caches key, refreshes on rotation and limits invalid-signature refreshes',async()=>{
  let now=start;
  const load=vi.fn().mockResolvedValueOnce(a.publicKey).mockResolvedValue(b.publicKey);
  const cache=createKickWebhookKeyCache({load,now:()=>now,ttlMs:60000,refreshCooldownMs:1000});
  const keys=await Promise.all([cache.get(),cache.get(),cache.get()]);
  expect(keys).toEqual([a.publicKey,a.publicKey,a.publicKey]);expect(load).toHaveBeenCalledTimes(1);
  const receiver=createKickWebhookReceiver({now:()=>now,keyCache:cache,resolveSubscription:()=>({type:'channel.followed',version:'1',broadcasterId:'1'}),onEvent:()=>{}});
  const frame=(id:string,key:typeof a.privateKey)=>{
   const time=new Date(now).toISOString(),body=Buffer.from(JSON.stringify({broadcaster:{user_id:1,channel_slug:'garden'},follower:{user_id:2,username:'fox'}}));
   return {body,headers:{'kick-event-message-id':id,'kick-event-message-timestamp':time,'kick-event-type':'channel.followed','kick-event-version':'1','kick-event-subscription-id':'sub','kick-event-signature':sign('RSA-SHA256',Buffer.concat([Buffer.from(id+'.'+time+'.'),body]),key).toString('base64')}};
  };
  expect(await receiver.receive(frame('first',a.privateKey))).toBe('accepted');
  now+=1000;
  expect(await receiver.receive(frame('rotated',b.privateKey))).toBe('accepted');
  expect(load).toHaveBeenCalledTimes(2);
  expect(await receiver.receive(frame('old',a.privateKey))).toBe('invalid');
  expect(load).toHaveBeenCalledTimes(2);
  now+=60000;await cache.get();expect(load).toHaveBeenCalledTimes(3);
 });
 it('fails closed when an expired key cannot be refreshed, and throttles failing loads',async()=>{
  let now=start;const load=vi.fn().mockResolvedValueOnce(a.publicKey).mockRejectedValue(new Error('offline'));
  const cache=createKickWebhookKeyCache({load,now:()=>now,ttlMs:1000,refreshCooldownMs:100});
  await cache.get();now+=1001;
  await expect(cache.get()).rejects.toThrow();
  await expect(cache.get()).rejects.toThrow();
  expect(load).toHaveBeenCalledTimes(2);
 });
});
