/** Server-only: verify raw bytes before parsing, then bind delivery to the
 * host's known subscription and broadcaster. Never publish a key or token. */
import {verify,createPublicKey,type KeyObject} from 'node:crypto';
import {normalizeKickOfficialEvent,KICK_OFFICIAL_EVENTS} from './official-events';
import type {ChatEvent} from '../../types/chat';
import {HttpError} from '../../network/fetch';
export interface KickWebhookSubscription {type:string;version:string;broadcasterId:string}
export type KickWebhookOptions = {
 resolveSubscription:(id:string)=>KickWebhookSubscription|undefined;
 onEvent:(event:ChatEvent)=>void|Promise<void>;
 now?:()=>number;
} & ({getPublicKey:()=>Promise<KeyObject|string>;keyCache?:never}|{keyCache:KickWebhookKeyCache;getPublicKey?:never});

export type KickWebhookResult='accepted'|'duplicate'|'invalid'|'unavailable';
export async function fetchKickWebhookPublicKey(fetcher:typeof fetch=fetch):Promise<string>{
 const url='https://api.kick.com/public/v1/public-key';
 const response=await fetcher(url,{signal:AbortSignal.timeout(5000),redirect:'error'});
 if(!response.ok)throw new HttpError(response.status,url);
 const reader=response.body?.getReader();
 if(!reader)throw Error('Kick public key unavailable');
 const chunks:Uint8Array[]=[];let size=0;
 try{
  while(true){
   const {done,value}=await reader.read();if(done)break;
   size+=value.byteLength;if(size>16384){await reader.cancel();throw Error('Kick public key response too large');}
   chunks.push(value);
  }
 }finally{reader.releaseLock();}
 const body=Buffer.concat(chunks).toString('utf8').trim();
 let key:unknown=body;
 if(body.startsWith('{'))key=JSON.parse(body)?.data?.public_key;
 if(typeof key!=='string'||key.length>8192||!key.trim().startsWith('-----BEGIN PUBLIC KEY-----'))throw Error('Kick public key unavailable');
 if(createPublicKey(key).asymmetricKeyType!=='rsa')throw Error('Kick public key is not RSA');
 return key.trim();
}
export interface KickWebhookKeyCache {
 get():Promise<KeyObject>;
 /** A mismatched signature may trigger at most one refresh per cooldown. */
 refreshAfterMismatch(key:KeyObject):Promise<KeyObject>;
}
export function createKickWebhookKeyCache(options:{load?:()=>Promise<KeyObject|string>;now?:()=>number;ttlMs?:number;refreshCooldownMs?:number}={}):KickWebhookKeyCache{
 const now=options.now??Date.now,load=options.load??fetchKickWebhookPublicKey;
 const ttl=options.ttlMs??3600000,cooldown=options.refreshCooldownMs??30000;
 if(!Number.isFinite(ttl)||ttl<=0||!Number.isFinite(cooldown)||cooldown<=0)throw Error('Invalid Kick key cache policy');
 let key:KeyObject|undefined,expires=0,nextAttempt=0,inFlight:Promise<KeyObject>|undefined;
 const refresh=():Promise<KeyObject>=>{
  if(inFlight)return inFlight;
  if(now()<nextAttempt)return Promise.reject(Error('Kick key refresh throttled'));
  nextAttempt=now()+cooldown;
  inFlight=Promise.resolve().then(()=>load()).then(value=>{
   const parsed=typeof value==='string'?createPublicKey(value):value;
   if(parsed.type!=='public'||parsed.asymmetricKeyType!=='rsa')throw Error('Invalid Kick RSA public key');
   key=parsed;expires=now()+ttl;return parsed;
  }).finally(()=>{inFlight=undefined;});
  return inFlight;
 };
 return {
  get(){return key&&now()<expires?Promise.resolve(key):refresh();},
  refreshAfterMismatch(used){
   if(key&&key!==used&&now()<expires)return Promise.resolve(key);
   if(inFlight)return inFlight;
   if(now()<nextAttempt&&key&&now()<expires)return Promise.resolve(key);
   return refresh();
  }
 };
}
export function createKickWebhookReceiver(options:KickWebhookOptions){
 const now=options.now??Date.now,seen=new Map<string,number>(),pending=new Set<string>();
 const maxAge=600000,maxFuture=30000,maxEntries=20000;
 return {async receive(input:{body:Uint8Array;headers:Record<string,string|string[]|undefined>}):Promise<KickWebhookResult>{
  const {headers,body}=input;
  const header=(name:string)=>{const v=headers[name];return typeof v==='string'&&v.length<=2048?v:undefined;};
  const messageId=header('kick-event-message-id'),time=header('kick-event-message-timestamp'),sig=header('kick-event-signature'),type=header('kick-event-type'),version=header('kick-event-version'),subId=header('kick-event-subscription-id');
  const at=time?Date.parse(time):NaN,current=now();
  if(!messageId||!subId||!time||!sig||!type||version!=='1'||!KICK_OFFICIAL_EVENTS.some(t=>t===type)||!Number.isFinite(at)||current-at>maxAge||at-current>maxFuture||!body.length||body.length>256*1024||!/^[-A-Za-z0-9_]+$/.test(messageId)||!/^[A-Za-z0-9+/]+={0,2}$/.test(sig))return 'invalid';
  const expected=options.resolveSubscription(subId);
  if(!expected||expected.type!==type||expected.version!==version)return 'invalid';
  let key:KeyObject|string;
  try{key=options.keyCache?await options.keyCache.get():await options.getPublicKey();}catch{return 'unavailable';}
  const signed=Buffer.concat([Buffer.from(messageId+'.'+time+'.'),body]),signature=Buffer.from(sig,'base64');
  const matches=(candidate:KeyObject|string)=>{try{return verify('RSA-SHA256',signed,candidate,signature);}catch{return false;}};
  if(!matches(key)){
   if(!options.keyCache||typeof key==='string')return 'invalid';
   try{key=await options.keyCache.refreshAfterMismatch(key);}catch{return 'unavailable';}
   if(!matches(key))return 'invalid';
  }
  let event:ChatEvent|null;
  try{event=normalizeKickOfficialEvent(type,JSON.parse(Buffer.from(body).toString('utf8')),{id:messageId,timestamp:at,broadcasterId:expected.broadcasterId});}catch{return 'invalid';}
  if(!event)return 'invalid';
  for(const [id,expiry] of seen){if(expiry<current)seen.delete(id);else break;}
  if(seen.has(messageId))return 'duplicate';
  // In-flight retries must not be acknowledged until the original succeeded.
  if(pending.has(messageId)||pending.size>=128||seen.size>=maxEntries)return 'unavailable';
  pending.add(messageId);
  try{await options.onEvent(event);seen.set(messageId,current+maxAge+maxFuture);return 'accepted';}catch{return 'unavailable';}finally{pending.delete(messageId);}
 }};
}
