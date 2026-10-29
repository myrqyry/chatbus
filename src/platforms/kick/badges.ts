/**
 * Kick subscriber badge artwork discovery. Kick's public website channel JSON
 * is undocumented and best-effort; the official chat wire supplies only refs.
 * This module is framework-neutral and does not infer arbitrary role icons.
 */
import type { Badge, BadgeRef } from '../../types/identity';

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
    if(!isRecord(value) || value.selected!==true)continue;
    const name=value.name;
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
export function createKickBadgeCatalog(load:JsonFetcher=fetchKickChannelBadgeJson) {
  let current:string|null=null;
  let generation=0;
  let state:KickBadgeCatalogState='idle';
  let tiers:KickSubscriberBadgeArtwork[]=[];
  let expiresAt=0;
  let pending:Promise<void>|null=null;
  return {
    loadChannel(channel:string,onReady:()=>void):Promise<void>{
      if(!CHANNEL.test(channel))return Promise.resolve();
      const slug=channel.toLowerCase();
      if(slug!==current){
        current=slug;generation++;tiers=[];state='idle';expiresAt=0;pending=null;
      }
      if(pending)return pending;
      if(Date.now()<expiresAt)return Promise.resolve();
      state='loading';
      const ticket=generation;
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
      return request;
    },
    resolve(refs:readonly BadgeRef[]):Badge[]{
      if(state!=='ready')return [];
      return refs.flatMap(ref=>{
        if(ref.provider!=='kick'||ref.id.toLowerCase()!=='subscriber')return [];
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
