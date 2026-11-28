import {describe,it,expect} from 'vitest';
import {generateKeyPairSync,sign} from 'node:crypto';
import {request} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openKickSqliteDeliveryStore} from '../src/platforms/kick/delivery-store';
import {createKickWebhookKeyCache} from '../src/platforms/kick/webhook';
import {createKickWebhookIngress,createKickSubscriptionRegistry} from '../src/platforms/kick/webhook-ingress';
import type {ChatEvent} from '../src/types/chat';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const now=Date.parse('2026-11-27T23:00:00Z');
const reg=()=>createKickSubscriptionRegistry([{id:'sub1',type:'channel.followed',version:'1',broadcasterId:'1'}]);
const frame=(id:string,body=Buffer.from('{ "broadcaster": {"user_id":1,"channel_slug":"garden"}, "follower":{"user_id":2,"username":"fox"} }'))=>{
 const time=new Date(now).toISOString();
 return {body,headers:{'content-type':'application/json','kick-event-message-id':id,'kick-event-message-timestamp':time,'kick-event-type':'channel.followed','kick-event-version':'1','kick-event-subscription-id':'sub1','kick-event-signature':sign('RSA-SHA256',Buffer.concat([Buffer.from(id+'.'+time+'.'),body]),privateKey).toString('base64')}};
};
const withIngress=async(fn:(url:string,events:ChatEvent[],registry:ReturnType<typeof reg>)=>Promise<void>,onEvent?: (e:ChatEvent)=>void|Promise<void>)=>{
 const dir=mkdtempSync(join(tmpdir(),'kick-ingress-')),store=openKickSqliteDeliveryStore(join(dir,'delivery.sqlite')),events:ChatEvent[]=[],registry=reg();
 const ingress=await createKickWebhookIngress({port:0,registry,deliveryStore:store,keyCache:createKickWebhookKeyCache({load:async()=>publicKey,now:()=>now}),now:()=>now,onEvent:onEvent??(e=>{events.push(e);})});
 try{await fn(ingress.address,events,registry);}finally{await ingress.close();store.close();rmSync(dir,{recursive:true,force:true});}
};
describe('isolated Kick webhook HTTP boundary',()=>{
 it('accepts exact signed bytes, persists duplicates, and never serves a control room',()=>withIngress(async(url,events)=>{
  expect(new URL(url).hostname).toBe('127.0.0.1');
  const f=frame('one');
  expect((await fetch(url+'/webhooks/kick',{method:'POST',...f})).status).toBe(204);
  expect((await fetch(url+'/webhooks/kick',{method:'POST',...f})).status).toBe(204);
  expect(events).toHaveLength(1);expect(events[0]?.type).toBe('follow');
  expect((await fetch(url+'/')).status).toBe(404);
  expect((await fetch(url+'/api/oauth/status')).status).toBe(404);
  expect((await fetch(url+'/webhooks/kick')).status).toBe(405);
 }));
 it('rejects altered bytes, unknown subscriptions, non-JSON, compressed and oversized bodies',()=>withIngress(async(url,events)=>{
  const f=frame('two');
  const send=(headers:Record<string,string>,body:Buffer=f.body)=>fetch(url+'/webhooks/kick',{method:'POST',headers,body});
  expect((await send(f.headers,Buffer.concat([f.body,Buffer.from(' ')]))).status).toBe(400);
  expect((await send({...f.headers,'kick-event-subscription-id':'unknown'})).status).toBe(400);
  expect((await send({...f.headers,'content-type':'text/plain'})).status).toBe(415);
  expect((await send({...f.headers,'content-encoding':'gzip'})).status).toBe(415);
  expect((await send(f.headers,Buffer.alloc(256*1024+1))).status).toBe(413);
  expect(events).toHaveLength(0);
  expect((await send(f.headers)).status).toBe(204);expect(events).toHaveLength(1);
 }));
 it('rejects duplicate signed headers even when the HTTP library would merge them',()=>withIngress(async(url,events)=>{
  const f=frame('three');
  const status=await new Promise<number>((resolve,reject)=>{
   const r=request(url+'/webhooks/kick',{method:'POST',headers:{...f.headers,'kick-event-message-id':['three','three']}},res=>{res.resume();resolve(res.statusCode!);});
   r.on('error',reject);r.end(f.body);
  });
  expect(status).toBe(400);expect(events).toHaveLength(0);
 }));
 it('reports sink failure as retryable and allows a retry',async()=>{
  let calls=0;
  await withIngress(async(url)=>{
   const f=frame('retry');
   const first=await fetch(url+'/webhooks/kick',{method:'POST',...f});
   expect(first.status).toBe(503);
   expect(first.headers.get('retry-after')).toBe('5');
   expect((await fetch(url+'/webhooks/kick',{method:'POST',...f})).status).toBe(204);
   expect(calls).toBe(2);
  },()=>{if(++calls===1)throw Error('sink failure');});
 });
 it('replaces only the chosen broadcaster inventory and rejects conflicting IDs atomically',()=>{
  const registry=reg();
  registry.replaceBroadcaster('2',[{id:'sub2',type:'kicks.gifted',version:'1',broadcasterId:'2'}]);
  expect(registry.resolve('sub1')?.broadcasterId).toBe('1');
  expect(()=>registry.replaceBroadcaster('1',[{id:'sub2',type:'channel.followed',version:'1',broadcasterId:'1'}])).toThrow();
  expect(registry.resolve('sub1')?.broadcasterId).toBe('1');
  registry.replaceBroadcaster('1',[]);
  expect(registry.resolve('sub1')).toBeUndefined();
  expect(registry.resolve('sub2')?.broadcasterId).toBe('2');
 });
 it('rejects oversized chunked bodies without normalizing partial data',()=>withIngress(async(url,events)=>{
  const f=frame('chunked');
  const status=await new Promise<number>((resolve,reject)=>{
   const r=request(url+'/webhooks/kick',{method:'POST',headers:f.headers},res=>{res.resume();resolve(res.statusCode!);});
   r.on('error',reject);r.write(Buffer.alloc(128*1024));r.end(Buffer.alloc(128*1024+1));
  });
  expect(status).toBe(413);expect(events).toHaveLength(0);
 }));
 it('drains active delivery callbacks before closing the server',async()=>{
  let finish!:()=>void,entered!:()=>void;
  const started=new Promise<void>(r=>{entered=r});
  const dir=mkdtempSync(join(tmpdir(),'kick-drain-')),store=openKickSqliteDeliveryStore(join(dir,'delivery.sqlite'));
  const ingress=await createKickWebhookIngress({port:0,registry:reg(),deliveryStore:store,keyCache:createKickWebhookKeyCache({load:async()=>publicKey,now:()=>now}),now:()=>now,onEvent:()=>new Promise<void>(r=>{finish=r;entered();})});
  try{
   const delivery=fetch(ingress.address+'/webhooks/kick',{method:'POST',...frame('drain')});
   await started;
   let closed=false;const closing=ingress.close().then(()=>{closed=true;});
   await new Promise(r=>setImmediate(r));expect(closed).toBe(false);
   finish();expect((await delivery).status).toBe(204);await closing;expect(closed).toBe(true);
  }finally{finish?.();await ingress.close();store.close();rmSync(dir,{recursive:true,force:true});}
 });

});
