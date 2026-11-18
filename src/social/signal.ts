import type { ChatEvent, ChatEventType, ChatPlatform, ChatUser } from '../types/chat';

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
    ...(upstreamBatchId ? { upstreamBatchId } : {}),
    ...(Object.keys(measurements).length ? { measurements } : {}),
  };
}
