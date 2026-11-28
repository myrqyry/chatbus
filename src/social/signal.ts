import type { ChatEvent, ChatEventType, ChatPlatform, ChatUser, HypeTrainPhase } from '../types/chat';

/** JSON-only evidence handoff to social consumers. Stable on the wire as v1. */
export interface SocialSignalV1 {
  schemaVersion: 1;
  producer: 'chatbus';
  source: {
    platform: ChatPlatform;
    channelId?: string;
    channelName?: string;
    connectionId?: string;
    upstream?: string;
    origin?: 'live' | 'replay' | 'test';
  };
  event: {
    type: ChatEventType;
    id?: string;
    occurredAtMs: number;
    receivedAtMs: number;
    /** Provider-scoped subscription tier when the source supplies one.
     * Twitch's 1000/2000/3000 become 1/2/3 and Prime remains Prime; YouTube
     * keeps its member-level name. Not a cross-platform identity ranking. */
    tier?: string;
  };
  actor?: {
    platform: ChatPlatform;
    id?: string;
    username: string;
    displayName?: string;
  };
  message?: {
    id: string;
    text: string;
    parentMessageId?: string;
    threadMessageId?: string;
  };
  /** Optional typed, bounded provider evidence; not raw event payloads. */
  hypeTrain?: {id:string;phase:HypeTrainPhase;level:number;total:number;progress?:number;goal?:number;expiresAtMs?:number};
  engagement?: EngagementEvidence;
  reward?: {id?:string;title?:string;cost?:number;input?:string};
  /** A source-provided correlation key, not proof of semantic equivalence. */
  upstreamBatchId?: string;
  /** Only explicitly recognized measurements; monetary amounts are NOT converted. */
  measurements?: {
    amount?: string;
    currency?: string;
    bits?: number;
    count?: number;
  };
}

export interface EngagementEvidence {
  kind:'poll'|'prediction'|'goal';id:string;phase:'begin'|'progress'|'lock'|'end';
  title?:string;status?:string;expiresAtMs?:number;winnerId?:string;
  choices?:{id:string;title:string;votes?:number;users?:number;points?:number}[];
  goalType?:string;current?:number;target?:number;achieved?:boolean;
}
export interface SocialSignalOptions {
  /** Local wall-clock receipt time; upstream timestamps are not local receipt time. */
  receivedAtMs?: number;
  /** Identifies the actual transport instance when multiple feeds share a platform/channel. */
  connectionId?: string;
}

const safeId = (candidate: unknown): string | undefined =>
  typeof candidate === 'string' && candidate.trim() ? candidate : undefined;

const nonnegativeCount = (candidate: unknown): number | undefined =>
  typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0
    ? candidate : undefined;

const boundedText = (candidate: unknown, limit: number): string | undefined =>
  typeof candidate === 'string' && candidate.trim()
    ? candidate.trim().slice(0, limit) : undefined;

const record = (value:unknown):Record<string,unknown> =>
  value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
function engagementEvidence(kind:ChatEventType,data:Record<string,unknown>):EngagementEvidence|undefined {
  if(kind!=='poll'&&kind!=='prediction'&&kind!=='goal')return undefined;
  const id=boundedText(data.id,128),phase=data.phase;
  if(!id||(phase!=='begin'&&phase!=='progress'&&phase!=='end'&&!(kind==='prediction'&&phase==='lock')))return undefined;
  const result:EngagementEvidence={kind,id,phase};
  const title=boundedText(kind==='goal'?data.description:data.title,160),status=boundedText(data.status,32);
  if(title)result.title=title;if(status)result.status=status;
  const end=kind==='prediction'?data.locks_at:data.ends_at;
  const expiry=typeof end==='string'?Date.parse(end):NaN;
  if(Number.isSafeInteger(expiry)&&expiry>=0)result.expiresAtMs=expiry;
  if(kind==='goal'){
    const goalType=boundedText(data.type,48),current=nonnegativeCount(data.current_amount),target=nonnegativeCount(data.target_amount);
    if(goalType)result.goalType=goalType;if(current!==undefined)result.current=current;if(target!==undefined)result.target=target;
    if(typeof data.is_achieved==='boolean')result.achieved=data.is_achieved;
  }else{
    const rows=kind==='poll'?data.choices:data.outcomes;
    if(Array.isArray(rows))result.choices=rows.slice(0,10).flatMap(value=>{
      const row=record(value),id=boundedText(row.id,128),title=boundedText(row.title,100);
      if(!id||!title)return [];
      const votes=kind==='poll'?nonnegativeCount(row.votes):undefined,users=kind==='prediction'?nonnegativeCount(row.users):undefined,points=kind==='prediction'?nonnegativeCount(row.channel_points):undefined;
      return [{id,title,...(votes!==undefined?{votes}:{}),...(users!==undefined?{users}:{}),...(points!==undefined?{points}:{})}];
    });
    const winner=kind==='prediction'&&phase==='end'&&status==='resolved'?boundedText(data.winning_outcome_id,128):undefined;
    if(winner)result.winnerId=winner;
  }
  return result;
}
function hypeEvidence(data:Record<string,unknown>):SocialSignalV1['hypeTrain'] {
  const id=boundedText(data.id,128),phase=data.phase,level=nonnegativeCount(data.level),total=nonnegativeCount(data.total);
  if(!id||(phase!=='begin'&&phase!=='progress'&&phase!=='end')||level===undefined||level<1||total===undefined)return undefined;
  const progress=nonnegativeCount(data.progress),goal=nonnegativeCount(data.goal);
  const expiry=typeof data.expiresAt==='string'?Date.parse(data.expiresAt):NaN;
  return {id,phase,level,total,...(progress!==undefined?{progress}:{}),...(goal!==undefined&&goal>0?{goal}:{}),
    ...(Number.isSafeInteger(expiry)&&expiry>=0?{expiresAtMs:expiry}:{})};
}
function rewardEvidence(data:Record<string,unknown>):SocialSignalV1['reward'] {
  const reward=record(data.reward),id=boundedText(reward.id,128),title=boundedText(reward.title,100),
    cost=nonnegativeCount(reward.cost),input=boundedText(data.userInput,240);
  const evidence={...(id?{id}:{}),...(title?{title}:{}),...(cost!==undefined?{cost}:{}),...(input?{input}:{})};
  return Object.keys(evidence).length?evidence:undefined;
}

/** Known subscription tier only; never inferred from names, badges or prices. */
function subscriptionTier(event: ChatEvent): string | undefined {
  if (event.type !== 'subscription' && event.type !== 'gift-subscription') return undefined;
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return undefined;
  const data = event.data as Record<string, unknown>;
  const nested = data.event && typeof data.event === 'object' && !Array.isArray(data.event)
    ? data.event as Record<string, unknown> : {};
  const raw = boundedText(nested.sub_tier ?? data.sub_tier, 40);
  if (raw) {
    const numeric = Number(raw);
    return Number.isInteger(numeric) && numeric > 0 && numeric % 1000 === 0 && numeric <= 3000
      ? String(numeric / 1000) : raw;
  }
  // YouTube membership notices spread newSponsorDetails or memberMilestoneChatDetails.
  return boundedText(data.memberLevelName, 80);
}

const fromUser = (user: ChatUser | undefined): SocialSignalV1['actor'] =>
  user && user.username.trim() ? {
    platform: user.platform,
    ...(safeId(user.id) ? { id: user.id } : {}),
    username: user.username,
    ...(safeId(user.displayName) ? { displayName: user.displayName } : {}),
  } : undefined;

/**
 * Pure evidence projection: no identity linking, sentiment/intent inference,
 * currency conversion, DOM dependency, or fabricated event IDs.
 *
 * Raw platform payload stays available on the original ChatEvent, but is
 * intentionally not serialized onto the cross-runtime social sensor bus.
 */
export function toSocialSignal(
  event: ChatEvent,
  options: SocialSignalOptions = {},
): SocialSignalV1 {
  const receivedAtMs = options.receivedAtMs ?? Date.now();
  if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0) {
    throw new RangeError('receivedAtMs must be a nonnegative integer');
  }
  if (!Number.isSafeInteger(event.timestamp) || event.timestamp < 0) {
    throw new RangeError('ChatEvent timestamp must be a nonnegative millisecond integer');
  }
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown> : {};
  const measurements: NonNullable<SocialSignalV1['measurements']> = {};
  if (typeof data.amount === 'string') measurements.amount = data.amount;
  if (typeof data.currency === 'string') measurements.currency = data.currency;
  const bits = nonnegativeCount(data.bits);
  const count = nonnegativeCount(data.count);
  if (bits !== undefined) measurements.bits = bits;
  if (count !== undefined) measurements.count = count;

  const id = safeId(event.id) ?? safeId(event.message?.id);
  const tier = subscriptionTier(event);
  const upstream = safeId(data.source);
  const upstreamBatchId = safeId(data.streamlabsEventId);
  const actor = fromUser(event.user ?? event.message?.user);
  const message = event.message;
  const hypeTrain=event.type==='hype-train'?hypeEvidence(data):undefined;
  const engagement=engagementEvidence(event.type,data);
  const reward=event.type==='reward-redemption'?rewardEvidence(data):undefined;
  return {
    schemaVersion: 1,
    producer: 'chatbus',
    source: {
      platform: event.platform,
      ...(safeId(event.channelId ?? message?.channelId) ? {
        channelId: event.channelId ?? message?.channelId,
      } : {}),
      ...(safeId(event.channelName ?? message?.channelName) ? {
        channelName: event.channelName ?? message?.channelName,
      } : {}),
      ...(safeId(options.connectionId) ? { connectionId: options.connectionId } : {}),
      ...(upstream ? { upstream } : {}),
      ...(event.origin ? { origin: event.origin } : {}),
    },
    event: {
      type: event.type,
      ...(id ? { id } : {}),
      occurredAtMs: event.timestamp,
      receivedAtMs,
      ...(tier ? { tier } : {}),
    },
    ...(actor ? { actor } : {}),
    ...(message ? { message: {
      id: message.id,
      text: message.text,
      ...(safeId(message.replyToMessageId ?? message.reply?.parentMessageId) ? {
        parentMessageId: message.replyToMessageId ?? message.reply?.parentMessageId,
      } : {}),
      ...(safeId(message.reply?.threadMessageId) ? {
        threadMessageId: message.reply?.threadMessageId,
      } : {}),
    } } : {}),
    ...(engagement?{engagement}:{}),
    ...(hypeTrain?{hypeTrain}:{}),
    ...(reward?{reward}:{}),
    ...(upstreamBatchId ? { upstreamBatchId } : {}),
    ...(Object.keys(measurements).length ? { measurements } : {}),
  };
}
