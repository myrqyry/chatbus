/** Server-side provisioning; only invoke for a host-owned, configured webhook. */
import {KICK_OFFICIAL_EVENTS,type KickOfficialEventType} from './official-events';
import {HttpError} from '../../network/fetch';
import type {KickWebhookSubscription} from './webhook';
const url='https://api.kick.com/public/v1/events/subscriptions';
export interface KickRegisteredSubscription extends KickWebhookSubscription {id:string;type:KickOfficialEventType}
export interface KickSubscriptionOptions {
 /** App access token from getKickAppAccessToken; user tokens ignore the broadcaster filter on POST. */
 appAccessToken:string;
 broadcasterId:string;
 events:readonly KickOfficialEventType[];
 fetcher?:typeof fetch;
 signal?:AbortSignal;
}
/** Explicit one-shot reconciliation. No deletes, implicit grants, timers or blind POST retries. */
export async function reconcileKickWebhookSubscriptions(options:KickSubscriptionOptions):Promise<{active:KickRegisteredSubscription[];missing:KickOfficialEventType[];created:KickRegisteredSubscription[]}>{
 const broadcaster=Number(options.broadcasterId);
 if(!Number.isSafeInteger(broadcaster)||broadcaster<=0||String(broadcaster)!==options.broadcasterId||!options.appAccessToken.trim())throw Error('Invalid Kick subscription authorization');
 const desired=[...new Set(options.events)];
 if(desired.some(e=>!KICK_OFFICIAL_EVENTS.includes(e)))throw Error('Unsupported Kick event type');
 const fetcher=options.fetcher??fetch;
 const headers={Authorization:'Bearer '+options.appAccessToken,'Content-Type':'application/json'};
 const request=async(method:'GET'|'POST',body?:unknown)=>{
  const timeout=AbortSignal.timeout(5000),signal=options.signal?AbortSignal.any([timeout,options.signal]):timeout;
  const r=await fetcher(method==='GET'?url+'?broadcaster_user_id='+broadcaster:url,{method,headers,signal,redirect:'error',...(body?{body:JSON.stringify(body)}:{})});
  if(!r.ok)throw new HttpError(r.status,url);
  const payload:unknown=await r.json();
  const data=(payload as {data?:unknown})?.data;
  if(!Array.isArray(data)||data.length>100000)throw Error('Invalid Kick subscriptions response');
  return data;
 };
 const list=async():Promise<KickRegisteredSubscription[]>=>{
  const rows=await request('GET'),active:KickRegisteredSubscription[]=[];
  for(const r of rows){
   if(!r||typeof r!=='object'||r.broadcaster_user_id!==broadcaster||r.method!=='webhook'||r.version!==1||!desired.includes(r.event)||typeof r.id!=='string'||!r.id||r.id.length>128)continue;
   active.push({id:r.id,type:r.event,version:'1',broadcasterId:options.broadcasterId});
  }
  return active;
 };
 const missing=(active:KickRegisteredSubscription[])=>desired.filter(type=>!active.some(x=>x.type===type));
 let active=await list();const absent=missing(active);
 const before=new Set(active.map(row=>row.id)),receipts=new Map<string,KickOfficialEventType>();
 if(absent.length){
  const result=await request('POST',{broadcaster_user_id:broadcaster,method:'webhook',events:absent.map(name=>({name,version:1}))});
  for(const row of result){
   if(row&&typeof row==='object'&&!row.error&&row.version===1&&absent.includes(row.name)&&typeof row.subscription_id==='string'&&/^[-A-Za-z0-9_]{1,128}$/.test(row.subscription_id)&&!before.has(row.subscription_id))receipts.set(row.subscription_id,row.name);
  }
  // Claim ownership only when a successful creation receipt agrees with readback.
  active=await list();
 }
 return {active,missing:missing(active),created:active.filter(row=>receipts.get(row.id)===row.type)};
}

export interface KickRemoveSubscriptionOptions {
 appAccessToken:string;
 broadcasterId:string;
 /** Explicit IDs only; never infer removal from absence in a desired list. */
 ids:readonly string[];
 fetcher?:typeof fetch;
 signal?:AbortSignal;
}
/** Inventory-gated, broadcaster-scoped deletion with readback. */
export async function removeKickWebhookSubscriptions(options:KickRemoveSubscriptionOptions):Promise<{removed:string[];notOwned:string[];remaining:string[]}>{
 const broadcaster=Number(options.broadcasterId);
 if(!Number.isSafeInteger(broadcaster)||broadcaster<=0||String(broadcaster)!==options.broadcasterId||!options.appAccessToken.trim())throw Error('Invalid Kick subscription authorization');
 const ids=[...new Set(options.ids)];
 if(ids.length>100||ids.some(id=>typeof id!=='string'||!/^[-A-Za-z0-9_]{1,128}$/.test(id)))throw Error('Invalid Kick subscription IDs');
 if(!ids.length)return {removed:[],notOwned:[],remaining:[]};
 const fetcher=options.fetcher??fetch;
 const request=async(method:'GET'|'DELETE',target:string)=>{
  const timeout=AbortSignal.timeout(5000),signal=options.signal?AbortSignal.any([timeout,options.signal]):timeout;
  const r=await fetcher(target,{method,headers:{Authorization:'Bearer '+options.appAccessToken},signal,redirect:'error'});
  if(!r.ok)throw new HttpError(r.status,url);
  return r;
 };
 const inventory=async()=>{
  const payload:unknown=await (await request('GET',url+'?broadcaster_user_id='+broadcaster)).json();
  const rows=(payload as {data?:unknown})?.data;
  if(!Array.isArray(rows)||rows.length>100000)throw Error('Invalid Kick subscriptions response');
  return new Set(rows.filter(r=>r&&typeof r==='object'&&r.broadcaster_user_id===broadcaster&&r.method==='webhook'&&typeof r.id==='string').map(r=>r.id as string));
 };
 const before=await inventory(),owned=ids.filter(id=>before.has(id)),notOwned=ids.filter(id=>!before.has(id));
 if(!owned.length)return {removed:[],notOwned,remaining:[]};
 const params=new URLSearchParams();for(const id of owned)params.append('id',id);
 const response=await request('DELETE',url+'?'+params);
 if(response.status!==204)throw Error('Unexpected Kick deletion response');
 const after=await inventory();
 return {removed:owned.filter(id=>!after.has(id)),notOwned,remaining:owned.filter(id=>after.has(id))};
}
