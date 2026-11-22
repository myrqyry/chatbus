import type { ChatEvent, ChatEventType, ChatPlatform, ChatUser, ChatFragment } from '../../types/chat';
import type { Badge } from '../../types/identity';

export interface SocialStreamNormalizeOptions {
  /** Local receive time: never invent a source timestamp. */
  receivedAtMs?: number;
  /** Transport-scoped sequence used only when the source lacks a stable ID. */
  fallbackId?: string;
}
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
const string = (value: unknown, max = 512): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const https = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : undefined; }
  catch { return undefined; }
};
const decode = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (part, entity: string) => {
    const key = entity.toLowerCase();
    const known: Record<string, string> = {amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' '};
    if (known[key]) return known[key];
    if (!key.startsWith('#')) return part;
    const code = key.startsWith('#x') ? parseInt(key.slice(2),16) : parseInt(key.slice(1),10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code) : '';
  });

/** Source HTML is a data format, never executable overlay markup. */
function asPlainText(value: string, literal: boolean): string {
  if (literal) return value.slice(0, 8000);
  return decode(value.slice(0, 8000)
    .replace(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<img\b[^>]*>/gi, tag => {
      const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      return alt ? (alt[1] ?? alt[2] ?? '') : '';
    })
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '')
  ).replace(/[ \t]{2,}/g, ' ').trim();
}
/** Recover image emotes without treating upstream HTML as executable markup. */
function safeFragments(body:string,literal:boolean):ChatFragment[] {
  if(literal)return [{type:'text',text:body.slice(0,8000)}];
  const source=body.slice(0,8000)
    .replace(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  const chunks:ChatFragment[]=[];
  const tags=/<img\b[^>]*>|<br\s*\/?\s*>|<\/?[a-z][^>]*>/gi;
  let previous=0,pending='';
  const flush=()=>{if(pending){chunks.push({type:'text',text:decode(pending)});pending='';}};
  for(const tag of source.matchAll(tags)){
    pending+=source.slice(previous,tag.index);
    previous=tag.index+tag[0].length;
    if(/^<br\b/i.test(tag[0])){pending+='\n';continue;}
    if(!/^<img\b/i.test(tag[0]))continue;
    const label=/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag[0]);
    const src=/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag[0]);
    const alt=decode((label?.[1]??label?.[2]??'').slice(0,150));
    const url=https(src?.[1]??src?.[2]);
    if(!url){pending+=alt;continue;}
    flush();
    const code=alt||'emote';
    chunks.push({type:'emote',text:code,emote:{
      id:'ssn:'+url,code,url,provider:'custom',zeroWidth:false,
    },overlays:[],modifiers:[]});
  }
  pending+=source.slice(previous);
  flush();
  return chunks.filter(part=>part.type!=='text'||part.text.length>0);
}

const platformOf = (value: string): ChatPlatform =>
  value === 'twitch' || value === 'kick' || value === 'youtube' || value === 'tiktok'
    ? value : 'custom';
const eventOf = (value: string | undefined): ChatEventType | null => {
  switch (value?.toLowerCase().replace(/-/g,'_')) {
    case 'superchat': case 'supersticker': case 'donation': case 'tip': return 'donation';
    case 'follow': case 'new_follower': return 'follow';
    case 'subscription': case 'subscribe': case 'new_subscriber': return 'subscription';
    case 'gift_subscription': case 'giftpurchase': return 'gift-subscription';
    case 'raid': return 'raid';
    case 'cheer': case 'bits': return 'cheer';
    default: return null;
  }
};
function badgesOf(value: unknown): Badge[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 24).flatMap((candidate, index): Badge[] => {
    const b = record(candidate);
    const url = https(typeof candidate === 'string' ? candidate : b?.src ?? b?.url);
    if (!url) return [];
    const label = string(b?.label ?? b?.title ?? b?.name, 90) ?? 'Badge';
    return [{ id: 'ssn:' + index + ':' + url, provider: 'custom', scope: 'user',
      name: label, images: [{url}] }];
  });
}

/** Pure translation of the documented SSN event fields, not a GPL implementation. */
export function normalizeSocialStreamMessage(
  input: unknown, options: SocialStreamNormalizeOptions = {},
): ChatEvent | null {
  const packet = record(input);
  if (!packet) return null;
  const sourcePlatform = string(packet.type, 60)?.toLowerCase();
  if (!sourcePlatform || !/^[a-z][a-z0-9_-]*$/.test(sourcePlatform)) return null;
  const meta = record(packet.meta);
  const name = string(packet.chatname, 200);
  const explicitKind = string(packet.event, 60);
  const kind = eventOf(explicitKind);
  if (!name) return null;
  const rawBody = typeof packet.chatmessage === 'string' ? packet.chatmessage : '';
  const body = asPlainText(rawBody, packet.textonly === true);
  if (!body && !kind) return null;
  const upstreamId = string(meta?.messageId ?? packet.id, 256);
  const syntheticId = !upstreamId;
  const fallback = string(options.fallbackId, 128);
  if (!upstreamId && !fallback) return null;
  const id = 'ssn:' + sourcePlatform + ':' + (upstreamId ?? 'local:' + fallback!);
  const timestamp = options.receivedAtMs ?? Date.now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return null;
  const platform = platformOf(sourcePlatform);
  const channelName = 'ssn:' + sourcePlatform + ':' +
    (string(meta?.channelId ?? packet.videoid ?? packet.channel, 100) ?? 'feed');
  const badgeList = badgesOf(packet.chatbadges);
  const user: ChatUser = {platform, username:name,
    ...(string(meta?.userId ?? packet.userid, 160) ? {id:string(meta?.userId ?? packet.userid, 160)} : {}),
    ...(string(packet.chatname, 200) ? {displayName:name} : {}),
    ...(badgeList.length ? {badges:badgeList} : {}),
    ...(typeof packet.nameColor === 'string' && /^#[\da-f]{6}$/i.test(packet.nameColor)
      ? {color:packet.nameColor} : {}),
  };
  const displayAmount = string(packet.hasDonation, 100);
  const eventType: ChatEventType = kind ?? 'message';
  return {
    id, platform, type:eventType, timestamp, channelName, user,
    data:{source:'socialstream',sourcePlatform, ...(explicitKind?{sourceType:explicitKind}:{}),
      ...(displayAmount?{displayAmount}:{}), ...(syntheticId?{syntheticId:true}:{})},
    ...(body ? {message:{id,platform,channelName,timestamp,user,text:body,
      fragments:safeFragments(rawBody,packet.textonly===true)}} : {}),
  };
}
