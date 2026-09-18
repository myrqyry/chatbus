import type { KickProtocolDataByType, KickProtocolEvent } from './types';

const EVENT_NAME_TO_TYPE: Record<string, keyof KickProtocolDataByType> = {
  'App\\Events\\ChatMessageEvent': 'ChatMessage',
  'App\\Events\\SubscriptionEvent': 'Subscription',
  'App\\Events\\GiftedSubscriptionsEvent': 'GiftedSubscriptions',
  'App\\Events\\ChannelSubscriptionEvent': 'ChannelSubscription',
  'App\\Events\\LuckyUsersWhoGotGiftSubscriptionsEvent': 'LuckyGiftedSubscriptions',
  'App\\Events\\StreamHostEvent': 'StreamHost',
  'App\\Events\\MessageDeletedEvent': 'MessageDeleted',
  'App\\Events\\UserBannedEvent': 'UserBanned',
  'App\\Events\\UserUnbannedEvent': 'UserUnbanned',
  'App\\Events\\PinnedMessageCreatedEvent': 'PinnedMessageCreated',
  'App\\Events\\PinnedMessageDeletedEvent': 'PinnedMessageDeleted',
  'App\\Events\\PollUpdateEvent': 'PollUpdate',
  'App\\Events\\PollDeleteEvent': 'PollDelete',
};

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string | number =>
  typeof value === 'string' || typeof value === 'number';

const isValidPayload = (type: keyof KickProtocolDataByType, data: Record<string, unknown>): boolean => {
  if (type === 'ChatMessage') {
    const sender = data.sender;
    return typeof data.id === 'string'
      && typeof data.chatroom_id === 'number'
      && typeof data.content === 'string'
      && typeof data.created_at === 'string'
      && isRecord(sender)
      && isId(sender.id)
      && typeof sender.username === 'string';
  }
  if (type === 'Subscription') return typeof data.username === 'string';
  return true;
};

export function parseKickPusherFrame(frame: string): KickProtocolEvent | null {
  const envelope = parseJson(frame);
  if (!isRecord(envelope) || typeof envelope.event !== 'string') return null;

  const type = EVENT_NAME_TO_TYPE[envelope.event];
  if (!type) return null;

  const rawData = typeof envelope.data === 'string' ? parseJson(envelope.data) : envelope.data;
  if (!isRecord(rawData) || !isValidPayload(type, rawData)) return null;

  return { type, data: rawData } as KickProtocolEvent;
}
