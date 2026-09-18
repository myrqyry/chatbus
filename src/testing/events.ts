import type {
  ChatEvent,
  ChatEventOrigin,
  ChatEventType,
  ChatFragment,
  ChatMessage,
  ChatPlatform,
  ChatUser,
} from '../types/chat';

const CHAT_EVENT_TYPES: ReadonlySet<string> = new Set<ChatEventType>([
  'message',
  'message-delete',
  'user-timeout',
  'user-ban',
  'subscription',
  'gift-subscription',
  'cheer',
  'raid',
  'follow',
  'donation',
  'channel-update',
  'reward-redemption',
  'room-state',
  'hype-train',
  'stream-online',
  'stream-offline',
  'system',
]);

const CHAT_PLATFORMS: ReadonlySet<string> = new Set<ChatPlatform>([
  'twitch',
  'kick',
  'youtube',
  'custom',
]);

const CHAT_EVENT_ORIGINS: ReadonlySet<string> = new Set<ChatEventOrigin>([
  'live',
  'replay',
  'test',
]);

const EMOTE_PROVIDERS = new Set([
  'twitch',
  'twitch-cheer',
  'kick',
  'youtube',
  '7tv',
  'bttv',
  'ffz',
  'emoji',
  'custom',
]);

const BADGE_PROVIDERS = new Set([
  'twitch',
  'kick',
  'youtube',
  '7tv',
  'bttv',
  'ffz',
  'custom',
]);

const BADGE_SCOPES = new Set(['native', 'channel', 'global', 'user', 'custom']);

export interface TestMessageEventOptions {
  platform?: ChatPlatform;
  channelId?: string;
  channelName?: string;
  timestamp?: number;
  eventId?: string;
  messageId?: string;
  userId?: string;
  username?: string;
  displayName?: string;
  text?: string;
  fragments?: ChatFragment[];
  data?: unknown;
  raw?: unknown;
}

export interface ChatEventRecorderOptions {
  limit?: number;
}

export const chatEventOrigin = (event: ChatEvent): ChatEventOrigin => event.origin ?? 'live';

export function createTestChatEvent<T = unknown>(
  type: ChatEventType,
  overrides: Partial<Omit<ChatEvent<T>, 'type' | 'origin'>> = {},
): ChatEvent<T> {
  const platform = overrides.platform ?? 'custom';
  const timestamp = overrides.timestamp ?? 0;
  return {
    ...overrides,
    id: overrides.id ?? `test:${platform}:${type}`,
    type,
    platform,
    timestamp,
    origin: 'test',
  };
}

export function createTestMessageEvent(options: TestMessageEventOptions = {}): ChatEvent {
  const platform = options.platform ?? 'custom';
  const timestamp = options.timestamp ?? 0;
  const text = options.text ?? 'Test message';
  const user: ChatUser = {
    platform,
    id: options.userId ?? 'test-user',
    username: options.username ?? 'test-user',
    displayName: options.displayName ?? 'Test User',
  };
  const messageId = options.messageId ?? 'test-message';
  const message: ChatMessage = {
    id: messageId,
    platform,
    channelId: options.channelId,
    channelName: options.channelName,
    user,
    text,
    fragments: options.fragments ?? [{ type: 'text', text }],
    timestamp,
  };

  return createTestChatEvent('message', {
    id: options.eventId ?? messageId,
    platform,
    channelId: options.channelId,
    channelName: options.channelName,
    timestamp,
    user,
    message,
    data: options.data,
    raw: options.raw,
  });
}

export function replayChatEvent<T = unknown>(
  event: ChatEvent<T>,
  overrides: Partial<Omit<ChatEvent<T>, 'origin'>> = {},
): ChatEvent<T> {
  const timestamp = overrides.timestamp ?? event.timestamp;
  const message = overrides.message ?? (event.message ? {
    ...event.message,
    ...(overrides.timestamp !== undefined ? { timestamp } : {}),
  } : undefined);

  return {
    ...event,
    ...overrides,
    timestamp,
    ...(message ? { message } : {}),
    origin: 'replay',
  };
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isOptionalString = (value: unknown): boolean =>
  value === undefined || typeof value === 'string';

const isOptionalBoolean = (value: unknown): boolean =>
  value === undefined || typeof value === 'boolean';

const isOptionalFiniteNumber = (value: unknown): boolean =>
  value === undefined || isFiniteNumber(value);

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isNumberPair = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber);

const isBadgeRef = (value: unknown): boolean => {
  const badge = asRecord(value);
  return Boolean(
    badge &&
    typeof badge.id === 'string' &&
    typeof badge.provider === 'string' && BADGE_PROVIDERS.has(badge.provider) &&
    isOptionalString(badge.version) &&
    isOptionalString(badge.info)
  );
};

const isBadgeImage = (value: unknown): boolean => {
  const image = asRecord(value);
  return Boolean(
    image &&
    typeof image.url === 'string' &&
    isOptionalFiniteNumber(image.width) &&
    isOptionalFiniteNumber(image.height) &&
    isOptionalString(image.format) &&
    isOptionalFiniteNumber(image.scale)
  );
};

const isBadge = (value: unknown): boolean => {
  const badge = asRecord(value);
  return Boolean(
    badge &&
    typeof badge.id === 'string' &&
    typeof badge.provider === 'string' && BADGE_PROVIDERS.has(badge.provider) &&
    typeof badge.scope === 'string' && BADGE_SCOPES.has(badge.scope) &&
    isOptionalString(badge.version) &&
    isOptionalString(badge.name) &&
    isOptionalString(badge.title) &&
    isOptionalString(badge.tooltip) &&
    Array.isArray(badge.images) && badge.images.every(isBadgeImage) &&
    isOptionalFiniteNumber(badge.slot) &&
    isOptionalString(badge.replaces) &&
    isOptionalString(badge.color)
  );
};

const isNamePaintStop = (value: unknown): boolean => {
  const stop = asRecord(value);
  return Boolean(
    stop &&
    isFiniteNumber(stop.at) &&
    isFiniteNumber(stop.color) &&
    (stop.centerAt === undefined || isNumberPair(stop.centerAt))
  );
};

const isNamePaintGradient = (value: unknown): boolean => {
  const gradient = asRecord(value);
  return Boolean(
    gradient &&
    isOptionalString(gradient.function) &&
    isOptionalString(gradient.canvasRepeat) &&
    (gradient.canvasSize === undefined || isNumberPair(gradient.canvasSize)) &&
    (gradient.at === undefined || isNumberPair(gradient.at)) &&
    Array.isArray(gradient.stops) && gradient.stops.every(isNamePaintStop) &&
    isOptionalString(gradient.imageUrl) &&
    isOptionalString(gradient.shape) &&
    isOptionalFiniteNumber(gradient.angle) &&
    isOptionalBoolean(gradient.repeat)
  );
};

const isNamePaintShadow = (value: unknown): boolean => {
  const shadow = asRecord(value);
  return Boolean(
    shadow &&
    isFiniteNumber(shadow.xOffset) &&
    isFiniteNumber(shadow.yOffset) &&
    isFiniteNumber(shadow.radius) &&
    isFiniteNumber(shadow.color)
  );
};

const isNamePaint = (value: unknown): boolean => {
  const paint = asRecord(value);
  return Boolean(
    paint &&
    typeof paint.id === 'string' &&
    (paint.provider === '7tv' || paint.provider === 'custom') &&
    isOptionalString(paint.name) &&
    isOptionalFiniteNumber(paint.color) &&
    (paint.gradients === undefined || (
      Array.isArray(paint.gradients) && paint.gradients.every(isNamePaintGradient)
    )) &&
    (paint.shadows === undefined || (
      Array.isArray(paint.shadows) && paint.shadows.every(isNamePaintShadow)
    )) &&
    isOptionalString(paint.function) &&
    isOptionalBoolean(paint.repeat) &&
    isOptionalFiniteNumber(paint.angle) &&
    isOptionalString(paint.shape) &&
    isOptionalString(paint.imageUrl) &&
    (paint.stops === undefined || (
      Array.isArray(paint.stops) && paint.stops.every(isNamePaintStop)
    ))
  );
};

const isChatUser = (value: unknown): value is ChatUser => {
  const user = asRecord(value);
  return Boolean(
    user &&
    typeof user.platform === 'string' && CHAT_PLATFORMS.has(user.platform) &&
    typeof user.username === 'string' &&
    isOptionalString(user.id) &&
    isOptionalString(user.displayName) &&
    isOptionalString(user.color) &&
    (user.roles === undefined || isStringArray(user.roles)) &&
    (user.badgeRefs === undefined || (
      Array.isArray(user.badgeRefs) && user.badgeRefs.every(isBadgeRef)
    )) &&
    (user.badges === undefined || (
      Array.isArray(user.badges) && user.badges.every(isBadge)
    )) &&
    (user.namePaint === undefined || isNamePaint(user.namePaint))
  );
};

const isEmoteImage = (value: unknown): boolean => {
  const image = asRecord(value);
  return Boolean(
    image &&
    typeof image.url === 'string' &&
    isOptionalFiniteNumber(image.width) &&
    isOptionalFiniteNumber(image.height) &&
    isOptionalString(image.format) &&
    isOptionalFiniteNumber(image.scale) &&
    isOptionalBoolean(image.animated) &&
    (image.theme === undefined || image.theme === 'dark' || image.theme === 'light')
  );
};

const isEmoteContent = (value: unknown): boolean => {
  const content = asRecord(value);
  return Boolean(
    content &&
    isOptionalBoolean(content.sexual) &&
    isOptionalBoolean(content.epilepsy) &&
    isOptionalBoolean(content.edgy) &&
    isOptionalBoolean(content.twitchDisallowed) &&
    isOptionalBoolean(content.listed)
  );
};

const isEmoteOverrides = (value: unknown): boolean => {
  const overrides = asRecord(value);
  return Boolean(
    overrides &&
    isOptionalBoolean(overrides.twitchGlobal) &&
    isOptionalBoolean(overrides.twitchSubscriber) &&
    isOptionalBoolean(overrides.betterTtv) &&
    isOptionalBoolean(overrides.frankerFaceZ)
  );
};

const isEmote = (value: unknown): boolean => {
  const emote = asRecord(value);
  return Boolean(
    emote &&
    typeof emote.code === 'string' &&
    typeof emote.id === 'string' &&
    typeof emote.url === 'string' &&
    typeof emote.zeroWidth === 'boolean' &&
    typeof emote.provider === 'string' && EMOTE_PROVIDERS.has(emote.provider) &&
    (emote.altUrls === undefined || isStringArray(emote.altUrls)) &&
    isOptionalBoolean(emote.animated) &&
    isOptionalString(emote.ownerName) &&
    (emote.images === undefined || (
      Array.isArray(emote.images) && emote.images.every(isEmoteImage)
    )) &&
    (emote.modifier === undefined || emote.modifier === 'overlay' || emote.modifier === 'hidden') &&
    (emote.content === undefined || isEmoteContent(emote.content)) &&
    (emote.overrides === undefined || isEmoteOverrides(emote.overrides))
  );
};

const isChatFragment = (value: unknown): value is ChatFragment => {
  const fragment = asRecord(value);
  if (!fragment || typeof fragment.type !== 'string' || typeof fragment.text !== 'string') return false;

  switch (fragment.type) {
    case 'text':
    case 'unknown':
      return true;
    case 'emote':
      return isEmote(fragment.emote) &&
        Array.isArray(fragment.overlays) && fragment.overlays.every(isEmote) &&
        Array.isArray(fragment.modifiers) && fragment.modifiers.every(isEmote);
    case 'modifier':
      return isEmote(fragment.emote);
    case 'mention':
      return isOptionalString(fragment.username) && isOptionalString(fragment.userId);
    case 'cheermote':
      return isFiniteNumber(fragment.bits) &&
        isOptionalString(fragment.prefix) &&
        isOptionalFiniteNumber(fragment.tier) &&
        (fragment.emote === undefined || isEmote(fragment.emote));
    case 'media':
      return (fragment.mediaType === 'gif' || fragment.mediaType === 'image') &&
        isOptionalString(fragment.id) &&
        typeof fragment.url === 'string' &&
        isOptionalString(fragment.alt);
    default:
      return false;
  }
};

const hasOnlyOptionalStrings = (value: unknown, keys: readonly string[]): boolean => {
  const record = asRecord(value);
  return Boolean(record && keys.every((key) => isOptionalString(record[key])));
};

const isChatMessageReply = (value: unknown): boolean => hasOnlyOptionalStrings(value, [
  'parentMessageId',
  'parentMessageBody',
  'parentUserId',
  'parentUsername',
  'parentDisplayName',
  'threadMessageId',
  'threadUserId',
  'threadUsername',
  'threadDisplayName',
]);

const isChatMessageSource = (value: unknown): boolean => {
  const source = asRecord(value);
  return Boolean(
    source &&
    ['channelId', 'channelName', 'displayName', 'messageId'].every((key) => isOptionalString(source[key])) &&
    (source.badgeRefs === undefined || (
      Array.isArray(source.badgeRefs) && source.badgeRefs.every(isBadgeRef)
    )) &&
    isOptionalBoolean(source.sourceOnly)
  );
};

const isChatMessageTraits = (value: unknown): boolean => {
  const traits = asRecord(value);
  return Boolean(
    traits &&
    isOptionalString(traits.messageType) &&
    isOptionalBoolean(traits.highlighted) &&
    isOptionalBoolean(traits.firstMessage) &&
    isOptionalBoolean(traits.emoteOnly) &&
    isOptionalString(traits.customRewardId)
  );
};

const isChatMessage = (value: unknown): value is ChatMessage => {
  const message = asRecord(value);
  return Boolean(
    message &&
    typeof message.id === 'string' &&
    typeof message.platform === 'string' && CHAT_PLATFORMS.has(message.platform) &&
    isOptionalString(message.channelId) &&
    isOptionalString(message.channelName) &&
    isChatUser(message.user) &&
    typeof message.text === 'string' &&
    Array.isArray(message.fragments) && message.fragments.every(isChatFragment) &&
    isFiniteNumber(message.timestamp) &&
    isOptionalString(message.replyToMessageId) &&
    (message.reply === undefined || isChatMessageReply(message.reply)) &&
    (message.source === undefined || isChatMessageSource(message.source)) &&
    (message.traits === undefined || isChatMessageTraits(message.traits))
  );
};

export function isChatEvent(value: unknown): value is ChatEvent {
  const event = asRecord(value);
  if (!event) return false;
  if (typeof event.type !== 'string' || !CHAT_EVENT_TYPES.has(event.type)) return false;
  if (typeof event.platform !== 'string' || !CHAT_PLATFORMS.has(event.platform)) return false;
  if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp)) return false;
  if (event.origin !== undefined && (
    typeof event.origin !== 'string' || !CHAT_EVENT_ORIGINS.has(event.origin)
  )) return false;
  if (!isOptionalString(event.id)) return false;
  if (!isOptionalString(event.channelId)) return false;
  if (!isOptionalString(event.channelName)) return false;
  if (event.user !== undefined && !isChatUser(event.user)) return false;
  if (event.message !== undefined && !isChatMessage(event.message)) return false;
  return true;
}

export function serializeChatEvent(event: ChatEvent, space?: number): string {
  return JSON.stringify(event, null, space);
}

export function deserializeChatEvent(serialized: string): ChatEvent {
  const value: unknown = JSON.parse(serialized);
  if (!isChatEvent(value)) throw new TypeError('Serialized value is not a valid ChatEvent');
  return value;
}

export function serializeChatEvents(events: readonly ChatEvent[], space?: number): string {
  return JSON.stringify(events, null, space);
}

export function deserializeChatEvents(serialized: string): ChatEvent[] {
  const value: unknown = JSON.parse(serialized);
  if (!Array.isArray(value) || !value.every(isChatEvent)) {
    throw new TypeError('Serialized value is not a valid ChatEvent array');
  }
  return value;
}

export class ChatEventRecorder {
  readonly limit: number;
  private readonly buffer: ChatEvent[] = [];

  constructor(options: ChatEventRecorderOptions = {}) {
    const limit = options.limit ?? 200;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('ChatEventRecorder limit must be a positive integer');
    }
    this.limit = limit;
  }

  get size(): number {
    return this.buffer.length;
  }

  record<T>(event: ChatEvent<T>): ChatEvent<T> {
    this.buffer.push(event as ChatEvent);
    if (this.buffer.length > this.limit) {
      this.buffer.splice(0, this.buffer.length - this.limit);
    }
    return event;
  }

  snapshot(): ChatEvent[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer.length = 0;
  }

  serialize(space?: number): string {
    return serializeChatEvents(this.buffer, space);
  }
}
