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
export async function reconcileKickWebhookSubscriptions(options:KickSubscriptionOptions):Promise<{active:KickRegisteredSubscription[];missing:KickOfficialEventType[]}>{
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
 if(absent.length){
  // A partial success or rejected event is not authoritative evidence of registration.
  await request('POST',{broadcaster_user_id:broadcaster,method:'webhook',events:absent.map(name=>({name,version:1}))});
  active=await list();
 }
 return {active,missing:missing(active)};
}
