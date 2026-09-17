import type { BadgeRef } from '../../types/identity';
import type {
  ChatEvent,
  ChatMessage,
  ChatMessageReply,
  ChatMessageSource,
  ChatMessageTraits,
  ChatUser,
} from '../../types/chat';
import { isTwitchMessageEmoteOnly, normalizeTwitchMessageFragments } from './message';
import type {
  TwitchChatMessagePayload,
  TwitchEventSubEnvelope,
  TwitchNormalizeContext,
} from './types';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

const eventTimestamp = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const normalized = value.replace(/(\.\d{3})\d+(Z|[+-]\d\d:\d\d)$/u, '$1$2');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const badgeRefsFrom = (badges: TwitchChatMessagePayload['badges']): BadgeRef[] =>
  (badges ?? []).flatMap((badge): BadgeRef[] => {
    if (!badge.set_id || !badge.id) return [];
    return [{
      id: badge.set_id,
      provider: 'twitch',
      version: badge.id,
      ...(badge.info ? { info: badge.info } : {}),
    }];
  });

const rolesFrom = (badges: TwitchChatMessagePayload['badges'], broadcaster: boolean): string[] => {
  const roles = new Set<string>();
  for (const badge of badges ?? []) {
    if (badge.set_id) roles.add(badge.set_id);
  }
  if (broadcaster) roles.add('broadcaster');
  return [...roles];
};

const userFromMessage = (event: TwitchChatMessagePayload): ChatUser => ({
  platform: 'twitch',
  id: event.chatter_user_id,
  username: event.chatter_user_login,
  displayName: event.chatter_user_name,
  color: event.color || undefined,
  roles: rolesFrom(event.badges, event.chatter_user_id === event.broadcaster_user_id),
  badgeRefs: badgeRefsFrom(event.badges),
  raw: event,
});

const replyFromMessage = (event: TwitchChatMessagePayload): ChatMessageReply | undefined => {
  const reply = event.reply;
  if (!reply) return undefined;
  return {
    parentMessageId: reply.parent_message_id,
    parentMessageBody: reply.parent_message_body,
    parentUserId: reply.parent_user_id,
    parentUsername: reply.parent_user_login,
    parentDisplayName: reply.parent_user_name,
    threadMessageId: reply.thread_message_id,
    threadUserId: reply.thread_user_id,
    threadUsername: reply.thread_user_login,
    threadDisplayName: reply.thread_user_name,
  };
};

const sourceFromMessage = (event: TwitchChatMessagePayload): ChatMessageSource | undefined => {
  const hasSource = Boolean(
    event.source_broadcaster_user_id ||
    event.source_broadcaster_user_login ||
    event.source_broadcaster_user_name ||
    event.source_message_id ||
    event.source_badges?.length ||
    typeof event.is_source_only === 'boolean',
  );
  if (!hasSource) return undefined;
  const badgeRefs = badgeRefsFrom(event.source_badges ?? undefined);
  return {
    channelId: event.source_broadcaster_user_id ?? undefined,
    channelName: event.source_broadcaster_user_login ?? undefined,
    displayName: event.source_broadcaster_user_name ?? undefined,
    messageId: event.source_message_id ?? undefined,
    badgeRefs: badgeRefs.length ? badgeRefs : undefined,
    sourceOnly: event.is_source_only ?? undefined,
  };
};

const traitsFromMessage = (
  event: TwitchChatMessagePayload,
  fragments: ChatMessage['fragments'],
): ChatMessageTraits => {
  const messageType = event.message_type ?? 'text';
  return {
    messageType,
    highlighted: messageType === 'channel_points_highlighted',
    firstMessage: messageType === 'user_intro',
    emoteOnly: isTwitchMessageEmoteOnly(fragments),
    customRewardId: event.channel_points_custom_reward_id ?? undefined,
  };
};

const normalizeMessage = (
  event: TwitchChatMessagePayload,
  envelope: TwitchEventSubEnvelope,
  context: TwitchNormalizeContext,
): ChatEvent => {
  const now = context.now?.() ?? Date.now();
  const timestamp = eventTimestamp(envelope.metadata.message_timestamp, now);
  const user = userFromMessage(event);
  const parsed = normalizeTwitchMessageFragments(
    event.message.text,
    event.message.fragments,
    context.emotes,
    context.cheermotes,
    context.getUserEmotes?.(event.chatter_user_id),
  );
  const message: ChatMessage = {
    id: event.message_id,
    platform: 'twitch',
    channelId: event.broadcaster_user_id,
    channelName: event.broadcaster_user_login,
    user,
    text: parsed.text,
    fragments: parsed.fragments,
    timestamp,
    replyToMessageId: event.reply?.parent_message_id,
    reply: replyFromMessage(event),
    source: sourceFromMessage(event),
    traits: traitsFromMessage(event, parsed.fragments),
    raw: event,
  };

  return {
    id: event.message_id,
    type: event.cheer?.bits ? 'cheer' : 'message',
    platform: 'twitch',
    channelId: event.broadcaster_user_id,
    channelName: event.broadcaster_user_login,
    timestamp,
    user,
    message,
    data: event.cheer?.bits ? { bits: event.cheer.bits } : undefined,
    raw: envelope,
  };
};

const badgeRowsFromUnknown = (value: unknown): NonNullable<TwitchChatMessagePayload['badges']> =>
  Array.isArray(value)
    ? value.flatMap((badge): NonNullable<TwitchChatMessagePayload['badges']> => {
      const row = asRecord(badge);
      if (!row) return [];
      const setId = stringValue(row.set_id);
      const id = stringValue(row.id);
      if (!setId || !id) return [];
      return [{
        set_id: setId,
        id,
        info: stringValue(row.info),
      }];
    })
    : [];

const notificationMessage = (
  event: Record<string, unknown>,
  envelope: TwitchEventSubEnvelope,
  context: TwitchNormalizeContext,
  user: ChatUser | undefined,
  channelId: string | undefined,
  channelName: string | undefined,
  timestamp: number,
): ChatMessage | undefined => {
  const messageId = stringValue(event.message_id);
  const message = asRecord(event.message);
  if (!messageId || !message || typeof message.text !== 'string' || !user) return undefined;
  const sourceFragments = Array.isArray(message.fragments)
    ? message.fragments as unknown as TwitchChatMessagePayload['message']['fragments']
    : undefined;
  const parsed = normalizeTwitchMessageFragments(
    message.text,
    sourceFragments,
    context.emotes,
    context.cheermotes,
    user.id ? context.getUserEmotes?.(user.id) : undefined,
  );

  return {
    id: messageId,
    platform: 'twitch',
    channelId,
    channelName,
    user,
    text: parsed.text,
    fragments: parsed.fragments,
    timestamp,
    traits: { emoteOnly: isTwitchMessageEmoteOnly(parsed.fragments) },
    raw: event,
  };
};

const normalizeNotification = (
  event: Record<string, unknown>,
  envelope: TwitchEventSubEnvelope,
  context: TwitchNormalizeContext,
): ChatEvent => {
  const now = context.now?.() ?? Date.now();
  const timestamp = eventTimestamp(envelope.metadata.message_timestamp, now);
  const noticeType = stringValue(event.notice_type) ?? 'unknown';
  const channelId = stringValue(event.broadcaster_user_id);
  const channelName = stringValue(event.broadcaster_user_login);
  const userId = stringValue(event.chatter_user_id);
  const username = stringValue(event.chatter_user_login);
  const displayName = stringValue(event.chatter_user_name);
  const badges = badgeRowsFromUnknown(event.badges);
  const user: ChatUser | undefined = username ? {
    platform: 'twitch',
    id: userId,
    username,
    displayName,
    color: stringValue(event.color),
    roles: rolesFrom(badges, userId !== undefined && userId === channelId),
    badgeRefs: badgeRefsFrom(badges),
    raw: event,
  } : undefined;

  let type: ChatEvent['type'] = 'system';
  if ([
    'sub',
    'resub',
    'gift_paid_upgrade',
    'prime_paid_upgrade',
    'shared_chat_sub',
    'shared_chat_resub',
    'shared_chat_gift_paid_upgrade',
    'shared_chat_prime_paid_upgrade',
  ].includes(noticeType)) {
    type = 'subscription';
  } else if ([
    'sub_gift',
    'community_sub_gift',
    'pay_it_forward',
    'shared_chat_sub_gift',
    'shared_chat_community_sub_gift',
    'shared_chat_pay_it_forward',
  ].includes(noticeType)) {
    type = 'gift-subscription';
  } else if (noticeType === 'raid' || noticeType === 'shared_chat_raid') {
    type = 'raid';
  }

  return {
    id: stringValue(event.message_id) ?? envelope.metadata.message_id,
    type,
    platform: 'twitch',
    channelId,
    channelName,
    timestamp,
    user,
    message: notificationMessage(event, envelope, context, user, channelId, channelName, timestamp),
    data: {
      kind: 'chat-notification',
      noticeType,
      systemMessage: stringValue(event.system_message),
      event,
    },
    raw: envelope,
  };
};

export function normalizeTwitchEventSubNotification(
  envelope: TwitchEventSubEnvelope,
  context: TwitchNormalizeContext = {},
): ChatEvent | null {
  if (envelope.metadata.message_type !== 'notification') return null;
  const event = asRecord(envelope.payload.event);
  const subscriptionType = envelope.metadata.subscription_type ?? envelope.payload.subscription?.type;
  if (!event || !subscriptionType) return null;

  if (subscriptionType === 'channel.chat.message') {
    const required = [
      event.broadcaster_user_id,
      event.broadcaster_user_login,
      event.chatter_user_id,
      event.chatter_user_login,
      event.message_id,
    ];
    const message = asRecord(event.message);
    if (required.some((value) => typeof value !== 'string') || !message || typeof message.text !== 'string') {
      return null;
    }
    return normalizeMessage(event as unknown as TwitchChatMessagePayload, envelope, context);
  }

  const now = context.now?.() ?? Date.now();
  const timestamp = eventTimestamp(envelope.metadata.message_timestamp, now);
  const channelId = stringValue(event.broadcaster_user_id);
  const channelName = stringValue(event.broadcaster_user_login);

  if (subscriptionType === 'channel.chat.message_delete') {
    return {
      id: stringValue(event.message_id) ?? envelope.metadata.message_id,
      type: 'message-delete',
      platform: 'twitch',
      channelId,
      channelName,
      timestamp,
      data: {
        messageId: stringValue(event.message_id),
        targetUserId: stringValue(event.target_user_id),
        targetUsername: stringValue(event.target_user_login),
      },
      raw: envelope,
    };
  }

  if (subscriptionType === 'channel.chat_settings.update') {
    return {
      id: envelope.metadata.message_id,
      type: 'room-state',
      platform: 'twitch',
      channelId,
      channelName,
      timestamp,
      data: event,
      raw: envelope,
    };
  }

  if (subscriptionType === 'channel.chat.clear') {
    return {
      id: envelope.metadata.message_id,
      type: 'system',
      platform: 'twitch',
      channelId,
      channelName,
      timestamp,
      data: { kind: 'chat-clear', event },
      raw: envelope,
    };
  }

  if (subscriptionType === 'channel.chat.clear_user_messages') {
    return {
      id: envelope.metadata.message_id,
      type: 'system',
      platform: 'twitch',
      channelId,
      channelName,
      timestamp,
      data: {
        kind: 'chat-clear-user',
        targetUserId: stringValue(event.target_user_id),
        targetUsername: stringValue(event.target_user_login),
        event,
      },
      raw: envelope,
    };
  }

  if (subscriptionType === 'channel.chat.notification') {
    return normalizeNotification(event, envelope, context);
  }

  if (subscriptionType === 'channel.update') {
    return {
      id: envelope.metadata.message_id,
      type: 'channel-update',
      platform: 'twitch',
      channelId,
      channelName,
      timestamp,
      data: {
        title: stringValue(event.title),
        language: stringValue(event.language),
        categoryId: stringValue(event.category_id),
        categoryName: stringValue(event.category_name),
        contentClassificationLabels: Array.isArray(event.content_classification_labels)
          ? event.content_classification_labels.filter((value): value is string => typeof value === 'string')
          : [],
      },
      raw: envelope,
    };
  }

  if (subscriptionType === 'stream.online' || subscriptionType === 'stream.offline') {
    return {
      id: stringValue(event.id) ?? envelope.metadata.message_id,
      type: subscriptionType === 'stream.online' ? 'stream-online' : 'stream-offline',
      platform: 'twitch',
      channelId,
      channelName,
      timestamp,
      data: {
        streamId: stringValue(event.id),
        streamType: stringValue(event.type),
        startedAt: stringValue(event.started_at),
      },
      raw: envelope,
    };
  }

  if (subscriptionType === 'channel.follow') {
    const username = stringValue(event.user_login);
    const user: ChatUser | undefined = username ? {
      platform: 'twitch',
      id: stringValue(event.user_id),
      username,
      displayName: stringValue(event.user_name),
      raw: event,
    } : undefined;
    return {
      id: envelope.metadata.message_id,
      type: 'follow',
      platform: 'twitch',
      channelId,
      channelName,
      timestamp,
      user,
      data: { followedAt: stringValue(event.followed_at) },
      raw: envelope,
    };
  }

  if (subscriptionType === 'channel.channel_points_custom_reward_redemption.add') {
    const username = stringValue(event.user_login);
    const user: ChatUser | undefined = username ? {
      platform: 'twitch',
      id: stringValue(event.user_id),
      username,
      displayName: stringValue(event.user_name),
      raw: event,
    } : undefined;
    return {
      id: stringValue(event.id) ?? envelope.metadata.message_id,
      type: 'reward-redemption',
      platform: 'twitch',
      channelId,
      channelName,
      timestamp,
      user,
      data: {
        redemptionId: stringValue(event.id),
        userInput: stringValue(event.user_input),
        status: stringValue(event.status),
        redeemedAt: stringValue(event.redeemed_at),
        reward: asRecord(event.reward) ?? undefined,
      },
      raw: envelope,
    };
  }

  if (subscriptionType === 'channel.ban') {
    const username = stringValue(event.user_login);
    const user: ChatUser | undefined = username ? {
      platform: 'twitch',
      id: stringValue(event.user_id),
      username,
      displayName: stringValue(event.user_name),
      raw: event,
    } : undefined;
    return {
      id: envelope.metadata.message_id,
      type: event.is_permanent === true ? 'user-ban' : 'user-timeout',
      platform: 'twitch',
      channelId,
      channelName,
      timestamp,
      user,
      data: {
        reason: stringValue(event.reason),
        bannedAt: stringValue(event.banned_at),
        endsAt: stringValue(event.ends_at),
        moderatorUserId: stringValue(event.moderator_user_id),
        moderatorUsername: stringValue(event.moderator_user_login),
      },
      raw: envelope,
    };
  }

  return null;
}
