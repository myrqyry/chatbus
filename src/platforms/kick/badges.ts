/**
 * Kick subscriber badge artwork discovery. Kick's public website channel JSON
 * is undocumented and best-effort; the official chat wire supplies only refs.
 * Known role vectors are acquired separately from public website assets;
 * this module is framework-neutral and does not infer arbitrary role icons.
 */
import type { Badge, BadgeRef } from '../../types/identity';
import {loadKickRoleArtwork} from './role-artwork';
import {sanitizeKickRoleBody,kickRoleArtworkKey,type KickRoleBodies} from './role-svg';

export interface KickSubscriberBadgeArtwork { months:number; url:string }
export type KickBadgeCatalogState='idle'|'loading'|'ready'|'degraded';
type JsonFetcher=(url:string)=>Promise<unknown>;
const TTL_MS=15*60*1000;
const FAILURE_COOLDOWN_MS=60*1000;
const MAX_RESPONSE_BYTES=1_000_000;
const CHANNEL=/^[a-z0-9_-]{1,48}$/i;
const IMAGE=/^https:\/\/files\.kick\.com\/channel_subscriber_badges\/\d+\/conversion\/[a-z0-9_-]+\.(?:png|webp)$/i;
const isRecord=(value:unknown):value is Record<string,unknown>=>
  typeof value==='object' && value!==null && !Array.isArray(value);

export function parseKickSubscriberBadges(payload:unknown):KickSubscriberBadgeArtwork[] {
  if(!isRecord(payload) || !Array.isArray(payload.subscriber_badges))
    throw new Error('Unexpected Kick subscriber badge catalog');
  const tiers=new Map<number,string>();
  for(const value of payload.subscriber_badges.slice(0,128)) {
    if(!isRecord(value))continue;
    const months=value.months;
    const asset=isRecord(value.badge_image)?value.badge_image.src:undefined;
    if(typeof months!=='number'||!Number.isInteger(months)||months<1||months>1200)continue;
    if(typeof asset!=='string'||!IMAGE.test(asset))continue;
    if(!tiers.has(months))tiers.set(months,asset);
  }
  return [...tiers].sort((a,b)=>a[0]-b[0]).map(([months,url])=>({months,url}));
}

/** Native Kick v2 chat badges supply their own artwork in sender identity.
 * `selected` distinguishes the user's displayed cosmetics from ownership.
 * No badge-name registry or channel lookup is required for these assets.
 */
export function parseKickUserBadgesV2(payload:unknown):Badge[] {
  if(!Array.isArray(payload))return [];
  const seen=new Set<string>();
  const output:{order:number;badge:Badge}[]=[];
  for(const value of payload.slice(0,60)) {
    if(!isRecord(value))continue;
    const name=value.name;
    // Kick renders Level SVGs even for selected=false entries. Unlike
    // optional cosmetics, this level marker is not user-selected.
    if(value.selected!==true && name!=='level')continue;
    const type=value.badge_type;
    const image=value.image_url;
    if(typeof name!=='string'||name.length<1||name.length>100||! /^[a-zA-Z0-9_-]+$/.test(name))continue;
    if(type!=='global' && type!=='channel' && type!=='user')continue;
    if(typeof image!=='string'||image.length>1024)continue;
    let url:URL;
    try {url=new URL(image);}catch{continue;}
    if(url.protocol!=='https:'||url.hostname!=='ext.cdn.kick.com'||url.port||url.username||url.password||url.hash)continue;
    if(!/^\/chat\/badges\/[a-zA-Z0-9_-]{1,200}\.(?:png|webp)$/i.test(url.pathname))continue;
    // Kick's web UI optionally requests a bounded, CDN-native resized image.
    if(url.search && !/^\?width=(?:[1-9]\d{0,2}),format=webp,quality=(?:[1-9]\d?|100)$/.test(url.search))continue;
    const key=type+':'+name;
    if(seen.has(key))continue;
    seen.add(key);
    const level=isRecord(value.metadata)?value.metadata.level:undefined;
    if(name==='level' && value.selected!==true && !(typeof level==='number' && Number.isInteger(level) && level>=1 && level<=10000))continue;
    const label=name==='level' && typeof level==='number' && Number.isInteger(level) && level>=1 && level<=10000
      ? `Level ${level}` : name;
    output.push({
      order:typeof value.sort_order==='number' && Number.isFinite(value.sort_order) ? value.sort_order : 10000,
      badge:{provider:'kick',id:name,scope:type,name:label,images:[{url:url.href}]},
    });
  }
  return output.sort((a,b)=>a.order-b.order).map(entry=>entry.badge);
}

/** Bound the source size and duration: even malformed provider JSON must not delay chat. */
export async function fetchKickChannelBadgeJson(url:string):Promise<unknown> {
  const response=await fetch(url,{signal:AbortSignal.timeout(8000),headers:{Accept:'application/json'}});
  if(!response.ok)throw new Error('Kick badge catalog HTTP '+response.status);
  const advertised=Number(response.headers.get('content-length'));
  if(advertised>MAX_RESPONSE_BYTES)throw new Error('Kick badge catalog exceeded maximum size');
  // Streaming cap also protects against absent/untruthful Content-Length.
  const reader=response.body?.getReader();
  if(!reader)throw new Error('Kick badge catalog had no response body');
  const chunks:Uint8Array[]=[];
  let total=0;
  try {
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.byteLength;
      if(total>MAX_RESPONSE_BYTES)throw new Error('Kick badge catalog exceeded maximum size');
      chunks.push(value);
    }
  } finally {await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(total);
  let offset=0;
  for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

/** One catalog per channel owner/session; stale channels cannot overwrite current art. */
export function createKickBadgeCatalog(
  load:JsonFetcher=fetchKickChannelBadgeJson,
  // A custom JSON loader is an isolated dependency by default; callers can
  // explicitly inject the independent role loader too.
  loadRoles:((channel:string)=>Promise<KickRoleBodies>)|null=
    load===fetchKickChannelBadgeJson?loadKickRoleArtwork:null,
) {
  let current:string|null=null;
  let generation=0;
  let state:KickBadgeCatalogState='idle';
  let tiers:KickSubscriberBadgeArtwork[]=[];
  let expiresAt=0;
  let pending:Promise<void>|null=null;
  let rolePending:Promise<void>|null=null;
  let roleBodies:KickRoleBodies={};
  let roleExpires=0;
  return {
    loadChannel(channel:string,onReady:()=>void):Promise<void>{
      if(!CHANNEL.test(channel))return Promise.resolve();
      const slug=channel.toLowerCase();
      if(slug!==current){
        current=slug;generation++;tiers=[];state='idle';expiresAt=0;pending=null;rolePending=null;roleBodies={};roleExpires=0;
      }
      const ticket=generation;
      if(loadRoles&&!rolePending&&Date.now()>=roleExpires){
        let request:Promise<KickRoleBodies>;
        try{request=loadRoles(slug);}catch(error){request=Promise.reject(error);}
        rolePending=request.then(bodies=>{
          if(ticket!==generation)return;
          const validated:KickRoleBodies={};
          for(const key of ['moderator','verified','gift-1','gift-25'] as const){
            const body=sanitizeKickRoleBody(bodies?.[key]);
            if(body)validated[key]=body;
          }
          roleBodies=validated;
          roleExpires=Date.now()+(Object.keys(validated).length===4?6*60*60*1000:10*60*1000);
        },()=>{if(ticket===generation)roleExpires=Date.now()+5*60*1000;})
        .then(()=>{if(ticket!==generation)return;rolePending=null;onReady();});
      }
      const roleWork=rolePending;
      const settle=(subscriber:Promise<void>|null)=>roleWork
        ?Promise.all([subscriber,roleWork]).then(()=>{}):subscriber??Promise.resolve();
      if(pending)return settle(pending);
      if(Date.now()<expiresAt)return settle(null);
      state='loading';
      const url=`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`;
      let loaded:Promise<unknown>;
      try { loaded=load(url); } catch(error) { loaded=Promise.reject(error); }
      const request=loaded.then(raw=>{
        const parsed=parseKickSubscriberBadges(raw);
        if(ticket!==generation)return;
        tiers=parsed;state='ready';expiresAt=Date.now()+TTL_MS;
      },()=>{
        if(ticket!==generation)return;
        state='degraded';expiresAt=Date.now()+FAILURE_COOLDOWN_MS;
      }).catch(()=>{
        if(ticket!==generation)return;
        state='degraded';expiresAt=Date.now()+FAILURE_COOLDOWN_MS;
      }).then(()=>{
        if(ticket!==generation)return;
        pending=null;
        onReady();
      });
      pending=request;
      return settle(request);
    },
    resolve(refs:readonly BadgeRef[]):Badge[]{
      return refs.flatMap((ref):Badge[]=>{
        if(ref.provider!=='kick')return [];
        const id=ref.id.toLowerCase();
        const key=kickRoleArtworkKey(ref);
        if(key&&roleBodies[key])return [{provider:'kick',scope:'native',id,
          ...(id==='sub_gifter'?{version:ref.version}:{}),
          name:id==='moderator'?'Moderator':id==='verified'?'Verified':ref.info||'Sub Gifter',
          images:[],svgBody:roleBodies[key]}];
        if(state!=='ready'||id!=='subscriber')return [];
        const count=ref.version;
        if(!count||!/^[1-9]\d{0,3}$/.test(count))return [];
        const months=Number(count);
        const milestone=tiers.filter(tier=>tier.months<=months).at(-1);
        if(!milestone)return [];
        return [{provider:'kick' as const,scope:'channel' as const,
          id:'subscriber',version:String(milestone.months),
          name:`Subscriber (${milestone.months} month${milestone.months===1?'':'s'})`,
          images:[{url:milestone.url}],
        }];
      });
    },
    health:():KickBadgeCatalogState=>state,
  };
}
export type KickBadgeCatalog=ReturnType<typeof createKickBadgeCatalog>;
