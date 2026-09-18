import { parseMessageFragments } from '../../messages/parse';
import type { ChatEvent, ChatMessage, ChatUser } from '../../types/chat';
import type { BadgeRef } from '../../types/identity';
import { parseKickMessageContent } from './emotes';
import type {
  KickChatMessagePayload,
  KickNormalizeContext,
  KickProtocolEvent,
  KickSender,
} from './types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseMetadata = (metadata: unknown): Record<string, unknown> | null => {
  if (isRecord(metadata)) return metadata;
  if (typeof metadata !== 'string') return null;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const badgeRefsFrom = (sender: KickSender): BadgeRef[] | undefined => {
  const raw = sender.identity?.badges;
  if (!Array.isArray(raw)) return undefined;

  const refs = raw.flatMap((badge): BadgeRef[] => {
    if (!isRecord(badge) || typeof badge.type !== 'string') return [];
    const count = typeof badge.count === 'number' || typeof badge.count === 'string'
      ? String(badge.count)
      : undefined;
    const info = typeof badge.text === 'string' ? badge.text : undefined;
    return [{ id: badge.type, provider: 'kick', version: count, info }];
  });

  return refs.length > 0 ? refs : undefined;
};

const userFromSender = (sender: KickSender): ChatUser => {
  const badgeRefs = badgeRefsFrom(sender);
  const roles = badgeRefs?.map((ref) => ref.id);
  return {
    platform: 'kick',
    id: String(sender.id),
    username: sender.username,
    displayName: sender.username,
    color: sender.identity?.color || undefined,
    roles: roles && roles.length > 0 ? roles : undefined,
    badgeRefs,
    raw: sender,
  };
};


const channelEventUser = (value: unknown): ChatUser | undefined => {
  if (!isRecord(value)) return undefined;
  const nested = isRecord(value.user) ? value.user : isRecord(value.subscriber) ? value.subscriber : value;
  const username = typeof nested.username === 'string'
    ? nested.username
    : typeof nested.slug === 'string'
      ? nested.slug
      : undefined;
  if (!username) return undefined;
  const id = typeof nested.id === 'string' || typeof nested.id === 'number' ? String(nested.id) : undefined;
  return { platform: 'kick', id, username, displayName: username, raw: value };
};

const timestampFrom = (value: string | undefined, now: () => number): number => {
  if (value) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return now();
};

const replyIdFrom = (metadata: unknown): string | undefined => {
  const parsed = parseMetadata(metadata);
  const original = parsed?.original_message;
  if (!isRecord(original)) return undefined;
  const id = original.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
};

function normalizeMessage(
  payload: KickChatMessagePayload,
  context: KickNormalizeContext,
): ChatEvent {
  const now = context.now ?? Date.now;
  const parsed = parseKickMessageContent(payload.content);
  const user = userFromSender(payload.sender);
  const timestamp = timestampFrom(payload.created_at, now);
  const channelId = context.channelId ?? String(payload.chatroom_id);

  const message: ChatMessage = {
    id: payload.id,
    platform: 'kick',
    channelId,
    channelName: context.channelName,
    user,
    text: parsed.text,
    fragments: parseMessageFragments(parsed.text, {
      emotes: context.emotes,
      nativeEmotes: parsed.nativeEmotes,
    }),
    timestamp,
    replyToMessageId: replyIdFrom(payload.metadata),
    raw: payload,
  };

  return {
    id: payload.id,
    type: 'message',
    platform: 'kick',
    channelId,
    channelName: context.channelName,
    timestamp,
    origin: 'live',
    user,
    message,
    raw: payload,
  };
}

export function normalizeKickEvent(
  event: KickProtocolEvent,
  context: KickNormalizeContext = {},
): ChatEvent | null {
  const now = context.now ?? Date.now;
  const base = {
    platform: 'kick' as const,
    channelId: context.channelId,
    channelName: context.channelName,
    timestamp: now(),
    origin: 'live' as const,
    raw: event.data,
  };

  switch (event.type) {
    case 'ChatMessage':
      return normalizeMessage(event.data, context);
    case 'MessageDeleted':
      return {
        ...base,
        id: event.data.id,
        type: 'message-delete',
        data: { messageId: event.data.message?.id },
      };
    case 'UserBanned': {
      const user = event.data.user?.username
        ? {
            platform: 'kick' as const,
            id: event.data.user.id == null ? undefined : String(event.data.user.id),
            username: event.data.user.username,
            displayName: event.data.user.username,
            raw: event.data.user,
          }
        : undefined;
      return {
        ...base,
        id: event.data.id,
        type: event.data.expires_at ? 'user-timeout' : 'user-ban',
        user,
        data: {
          expiresAt: event.data.expires_at ?? undefined,
          bannedBy: event.data.banned_by,
        },
      };
    }
    case 'Subscription':
      return {
        ...base,
        type: 'subscription',
        user: {
          platform: 'kick',
          username: event.data.username,
          displayName: event.data.username,
        },
        data: { months: event.data.months },
      };
    case 'GiftedSubscriptions':
      return {
        ...base,
        type: 'gift-subscription',
        user: event.data.gifter_username
          ? {
              platform: 'kick',
              username: event.data.gifter_username,
              displayName: event.data.gifter_username,
            }
          : undefined,
        data: { giftedUsernames: event.data.gifted_usernames ?? [] },
      };
    case 'ChannelSubscription':
      return {
        ...base,
        id: event.data.id == null ? undefined : String(event.data.id),
        type: 'subscription',
        user: channelEventUser(event.data),
        data: { kind: 'channel-subscription', event: event.data },
      };
    case 'LuckyGiftedSubscriptions':
      return {
        ...base,
        id: event.data.id == null ? undefined : String(event.data.id),
        type: 'gift-subscription',
        user: event.data.gifter_username
          ? { platform: 'kick', username: event.data.gifter_username, displayName: event.data.gifter_username }
          : undefined,
        data: {
          kind: 'lucky-gift-subscriptions',
          giftedUsernames: event.data.gifted_usernames ?? [],
          event: event.data,
        },
      };
    case 'StreamHost':
      return { ...base, type: 'system', data: { kind: 'host', ...event.data } };
    case 'UserUnbanned':
      return { ...base, id: event.data.id, type: 'system', data: { kind: 'user-unbanned', ...event.data } };
    case 'PinnedMessageCreated':
      return { ...base, type: 'system', data: { kind: 'pinned-message-created', ...event.data } };
    case 'PinnedMessageDeleted':
      return { ...base, id: event.data.id, type: 'system', data: { kind: 'pinned-message-deleted', ...event.data } };
    case 'PollUpdate':
      return { ...base, type: 'system', data: { kind: 'poll-update', ...event.data } };
    case 'PollDelete':
      return { ...base, type: 'system', data: { kind: 'poll-delete', ...event.data } };
    default:
      return null;
  }
}
