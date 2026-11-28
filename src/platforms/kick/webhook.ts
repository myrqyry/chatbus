/** Server-only: verify raw bytes before parsing, then bind delivery to the
 * host's known subscription and broadcaster. Never publish a key or token. */
import {verify,type KeyObject} from 'node:crypto';
import {normalizeKickOfficialEvent,KICK_OFFICIAL_EVENTS} from './official-events';
import type {ChatEvent} from '../../types/chat';
import {fetchJson} from '../../network/fetch';
export interface KickWebhookSubscription {type:string;version:string;broadcasterId:string}
export interface KickWebhookOptions {
 getPublicKey:()=>Promise<KeyObject|string>;
 resolveSubscription:(id:string)=>KickWebhookSubscription|undefined;
 onEvent:(event:ChatEvent)=>void|Promise<void>;
 now?:()=>number;
}
export type KickWebhookResult='accepted'|'duplicate'|'invalid'|'unavailable';
export async function fetchKickWebhookPublicKey():Promise<string>{
 const body=await fetchJson<{data?:{public_key?:unknown}}>('https://api.kick.com/public/v1/public-key',{},5000,0);
 const key=body.data?.public_key;
 if(typeof key!=='string'||key.length>8192||!key.includes('BEGIN PUBLIC KEY'))throw Error('Kick public key unavailable');
 return key;
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
  try{key=await options.getPublicKey();}catch{return 'unavailable';}
  try{if(!verify('RSA-SHA256',Buffer.concat([Buffer.from(messageId+'.'+time+'.'),body]),key,Buffer.from(sig,'base64')))return 'invalid';}catch{return 'invalid';}
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
