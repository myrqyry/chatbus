import { fetchJson } from '../network/fetch';

/**
 * Public Kick channel owner's profile picture.
 * The web-client channel endpoint is undocumented; failure is optional enrichment.
 */
const CHANNEL_URL = 'https://kick.com/api/v2/channels/';
const SUCCESS_TTL_MS = 30 * 60_000;
const FAILURE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 256;
const VALID_SLUG = /^[a-z0-9_-]{1,40}$/;

const cache = new Map<string,{value:string|null;expiresAt:number}>();
const pending = new Map<string,Promise<string|null>>();

function safeProfilePicture(value: unknown, id: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const userId = String(id ?? '');
  if (!/^[1-9]\d{0,19}$/.test(userId)) return null;
  try {
    const url = new URL(value);
    const prefix = `/images/user/${userId}/profile_image/`;
    // Only accept an image for this specific user on Kick's own image CDN.
    return url.protocol === 'https:' && url.hostname === 'files.kick.com'
      && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.startsWith(prefix)
      && /\.(?:png|jpe?g|webp|gif)$/i.test(url.pathname)
      ? url.href : null;
  } catch {
    return null;
  }
}

export function clearKickAvatarCache(channel?:string):void {
  if(channel)cache.delete(channel.trim().toLowerCase());
  else cache.clear();
}

/** Fetch just the channel owner's profile URL. No chat event is blocked on this. */
export function fetchKickUserAvatar(channel:string):Promise<string|null> {
  const slug=channel.trim().toLowerCase();
  if(!VALID_SLUG.test(slug))return Promise.resolve(null);
  const cached=cache.get(slug);
  if(cached && cached.expiresAt>Date.now())return Promise.resolve(cached.value);
  const inflight=pending.get(slug);
  if(inflight)return inflight;

  const task=fetchJson<unknown>(CHANNEL_URL+encodeURIComponent(slug))
    .then(result=>{
      if(!result || typeof result!=='object' || Array.isArray(result))return null;
      const user=(result as {user?:unknown}).user;
      if(!user || typeof user!=='object' || Array.isArray(user))return null;
      const record=user as {id?:unknown;profile_pic?:unknown};
      return safeProfilePicture(record.profile_pic,record.id);
    })
    .catch(()=>null)
    .then(value=>{
      cache.delete(slug);
      cache.set(slug,{value,expiresAt:Date.now()+(value?SUCCESS_TTL_MS:FAILURE_TTL_MS)});
      while(cache.size>MAX_CACHE_ENTRIES)cache.delete(cache.keys().next().value!);
      return value;
    })
    .finally(()=>{pending.delete(slug);});
  pending.set(slug,task);
  return task;
}
