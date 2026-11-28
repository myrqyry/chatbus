import type {ChatEvent} from '../../types/chat';
import {fetchJson} from '../../network/fetch';
import type {TwitchAuth,TwitchResolvedChannel} from './types';

type StateKind='poll'|'prediction'|'goal'|'charity'|'hype-train'|'reward-catalog';
type Row=Record<string,unknown>;
const record=(v:unknown):Row|null=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:null;
const string=(v:unknown)=>typeof v==='string'&&v.trim()?v:undefined;
const count=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const endpoints:readonly {kind:StateKind;path:string;scopes:readonly string[];latest?:boolean}[]=[
 {kind:'poll',path:'polls',scopes:['channel:read:polls','channel:manage:polls'],latest:true},
 {kind:'prediction',path:'predictions',scopes:['channel:read:predictions','channel:manage:predictions'],latest:true},
 {kind:'goal',path:'goals',scopes:['channel:read:goals']},
 {kind:'charity',path:'charity/campaigns',scopes:['channel:read:charity']},
 {kind:'hype-train',path:'hypetrain/status',scopes:['channel:read:hype_train']},
 {kind:'reward-catalog',path:'channel_points/custom_rewards',scopes:['channel:read:redemptions','channel:manage:redemptions']},
];
function expiry(start:unknown,seconds:unknown){
 const ms=typeof start==='string'?Date.parse(start):NaN;
 return Number.isFinite(ms)&&count(seconds)&&seconds<=86400?new Date(ms+seconds*1000).toISOString():undefined;
}
export interface TwitchBroadcasterStateOptions {
 signal?:AbortSignal;now?:()=>number;fetcher?:typeof fetch;
 onUnavailable?:(kind:StateKind)=>void;
}
/** Read existing state, never replay historical purchases. No credentials or
 * raw provider rows are sent in the returned evidence contract. */
export async function fetchTwitchBroadcasterState(auth:TwitchAuth,channel:TwitchResolvedChannel,options:TwitchBroadcasterStateOptions={}):Promise<ChatEvent[]>{
 if(auth.userId!==channel.id||options.signal?.aborted)return [];
 const requestedAt=options.now?.()??Date.now(),granted=new Set(auth.scopes??[]);
 const families=await Promise.all(endpoints.filter(e=>e.scopes.some(s=>granted.has(s))).map(async endpoint=>{
  const url=new URL('https://api.twitch.tv/helix/'+endpoint.path);
  url.searchParams.set('broadcaster_id',channel.id);
  if(endpoint.latest)url.searchParams.set('first','1');
  const init={headers:{'Client-Id':auth.clientId,Authorization:'Bearer '+auth.accessToken},signal:options.signal};
  try{
   const body=options.fetcher?await (async()=>{const res=await options.fetcher!(url.toString(),init);if(!res.ok)throw Error('Unavailable');return res.json();})():await fetchJson<{data?:unknown}>(url.toString(),init,5000,0);
   if(options.signal?.aborted)return [];
   if(!Array.isArray(body?.data))throw Error('Malformed state response');
   const result:ChatEvent[]=[];
   for(const value of body.data.slice(0,endpoint.kind==='reward-catalog'?100:20)){
    let row=record(value);if(!row)continue;
    const kind=endpoint.kind;
    if(kind==='hype-train'){row=record(row.current);if(!row)continue;}
    const id=string(row.id);if(!id||id.length>128)continue;
    if(row.broadcaster_id&&row.broadcaster_id!==channel.id||row.broadcaster_user_id&&row.broadcaster_user_id!==channel.id)continue;
    let data:Row;
    if(kind==='poll'){
     if(row.status!=='ACTIVE')continue;
     const ends=expiry(row.started_at,row.duration);
     if(ends&&Date.parse(ends)<=requestedAt)continue;
     data={id,phase:'progress',title:row.title,choices:row.choices,ends_at:ends};
    }else if(kind==='prediction'){
     if(row.status!=='ACTIVE'&&row.status!=='LOCKED')continue;
     data={id,phase:row.status==='LOCKED'?'lock':'progress',title:row.title,outcomes:row.outcomes,locks_at:expiry(row.created_at,row.prediction_window)};
    }else if(kind==='goal'){
     data={id,phase:'progress',type:row.type,description:row.description,current_amount:row.current_amount,target_amount:row.target_amount};
    }else if(kind==='charity'){
     data={id,phase:'progress',charity_name:row.charity_name,current_amount:row.current_amount,target_amount:row.target_amount};
    }else if(kind==='hype-train'){
     if(!count(row.level)||row.level<1||!count(row.total))continue;
     if(typeof row.expires_at==='string'&&Date.parse(row.expires_at)<=requestedAt)continue;
     data={id,phase:'progress',level:row.level,total:row.total,progress:row.progress,goal:row.goal,expiresAt:row.expires_at};
    }else{
     data={reward:{id,title:row.title,cost:row.cost,is_enabled:row.is_enabled},status:'snapshot'};
    }
    result.push({type:kind,platform:'twitch',channelId:channel.id,channelName:channel.login,timestamp:requestedAt,origin:'replay',data});
   }
   return result;
  }catch{if(!options.signal?.aborted)options.onUnavailable?.(endpoint.kind);return [];}
 }));
 return options.signal?.aborted?[]:families.flat();
}
