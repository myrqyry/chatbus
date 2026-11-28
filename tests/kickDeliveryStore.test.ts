import {describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync,statSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {createKickWebhookReceiver} from '../src/platforms/kick/webhook';
import {openKickSqliteDeliveryStore} from '../src/platforms/kick/delivery-store';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const now=Date.parse('2026-11-27T23:00:00Z');
const frame=(id:string)=>{
 const time=new Date(now).toISOString(),body=Buffer.from(JSON.stringify({broadcaster:{user_id:1,channel_slug:'garden'},follower:{user_id:2,username:'fox'}}));
 return {body,headers:{'kick-event-message-id':id,'kick-event-message-timestamp':time,'kick-event-type':'channel.followed','kick-event-version':'1','kick-event-subscription-id':'sub','kick-event-signature':sign('RSA-SHA256',Buffer.concat([Buffer.from(id+'.'+time+'.'),body]),privateKey).toString('base64')}};
};
const withDb=async(fn:(path:string)=>Promise<void>)=>{
 const dir=mkdtempSync(join(tmpdir(),'kick-dedup-'));
 try{await fn(join(dir,'delivery.sqlite'));}finally{rmSync(dir,{recursive:true,force:true});}
};
describe('persistent Kick delivery claims',()=>{
 it('survives receiver and database restart without re-emitting acknowledged events',()=>withDb(async path=>{
  let emissions=0;
  const receiver=(deliveryStore:ReturnType<typeof openKickSqliteDeliveryStore>)=>createKickWebhookReceiver({deliveryStore,now:()=>now,getPublicKey:async()=>publicKey,resolveSubscription:()=>({type:'channel.followed',version:'1',broadcasterId:'1'}),onEvent:()=>{emissions++;}});
  const db=openKickSqliteDeliveryStore(path);
  try{expect(await receiver(db).receive(frame('same'))).toBe('accepted');}finally{db.close();}
  const reopened=openKickSqliteDeliveryStore(path);
  try{expect(await receiver(reopened).receive(frame('same'))).toBe('duplicate');expect(emissions).toBe(1);expect(statSync(path).mode&0o777).toBe(0o600);}finally{reopened.close();}
 }));
 it('coordinates concurrent receivers, releases failed callbacks for retry',()=>withDb(async path=>{
  const a=openKickSqliteDeliveryStore(path),b=openKickSqliteDeliveryStore(path);
  let fail!:()=>void,entered!:()=>void;
  const ready=new Promise<void>(r=>{entered=r});
  const receiver=(deliveryStore:typeof a,onEvent:()=>void|Promise<void>)=>createKickWebhookReceiver({deliveryStore,now:()=>now,getPublicKey:async()=>publicKey,resolveSubscription:()=>({type:'channel.followed',version:'1',broadcasterId:'1'}),onEvent});
  try{
   const first=receiver(a,()=>new Promise<void>((_,reject)=>{fail=()=>reject(Error('sink failed'));entered();})).receive(frame('retry'));
   await ready;
   const second=receiver(b,()=>{});
   expect(await second.receive(frame('retry'))).toBe('unavailable');
   fail();expect(await first).toBe('unavailable');
   expect(await second.receive(frame('retry'))).toBe('accepted');
   expect(await second.receive(frame('retry'))).toBe('duplicate');
  }finally{a.close();b.close();}
 }));
 it('recovers expired claims with fencing, prunes expired records, and bounds capacity',()=>withDb(async path=>{
  const db=openKickSqliteDeliveryStore(path,{leaseMs:100,maxEntries:1});
  try{
   const a=db.claim('one',now,now+1000);expect(a.status).toBe('claimed');if(a.status!=='claimed')throw Error();
   expect(db.claim('two',now,now+1000).status).toBe('busy');
   expect(db.claim('one',now+99,now+1000).status).toBe('busy');
   const b=db.claim('one',now+101,now+1000);expect(b.status).toBe('claimed');if(b.status!=='claimed')throw Error();
   expect(db.complete('one',a.token)).toBe(false);
   expect(db.complete('one',b.token)).toBe(true);
   expect(db.claim('one',now+102,now+1000).status).toBe('duplicate');
   expect(db.claim('two',now+1001,now+2000).status).toBe('claimed');
  }finally{db.close();}
 }));
 it('does not let an invalid signature reserve a delivery or accept when the ledger is unavailable',()=>withDb(async path=>{
  const db=openKickSqliteDeliveryStore(path);let emitted=0;
  const receiver=createKickWebhookReceiver({deliveryStore:db,now:()=>now,getPublicKey:async()=>publicKey,resolveSubscription:()=>({type:'channel.followed',version:'1',broadcasterId:'1'}),onEvent:()=>{emitted++;}});
  const f=frame('auth-first');
  try{
   expect(await receiver.receive({...f,body:Buffer.concat([f.body,Buffer.from(' ')])})).toBe('invalid');
   expect(await receiver.receive(f)).toBe('accepted');
  }finally{db.close();}
  expect(await receiver.receive(frame('closed-store'))).toBe('unavailable');
  expect(emitted).toBe(1);
 }));
 it('refuses to open a ledger in a non-private directory or with unsafe permissions',()=>withDb(async path=>{
  const db=openKickSqliteDeliveryStore(path);db.close();
  chmodSync(path,0o644);
  expect(()=>openKickSqliteDeliveryStore(path)).toThrow('private file');
  chmodSync(path,0o600);
  const dir=path.slice(0,path.lastIndexOf('/'));chmodSync(dir,0o755);
  try{expect(()=>openKickSqliteDeliveryStore(path)).toThrow('private parent directory');}finally{chmodSync(dir,0o700);}
 }));

});
