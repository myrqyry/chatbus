import type { ChatEvent, ChatPlatform, ChatUser } from './types/chat';

export const DEFAULT_CHAT_TIMELINE_LIMIT = 100;

export type ChatTimelineDeletionReason =
  | 'message-delete'
  | 'user-timeout'
  | 'user-ban'
  | 'chat-clear'
  | 'chat-clear-user';

export interface ChatTimelineDeletion {
  reason: ChatTimelineDeletionReason;
  timestamp: number;
  eventId?: string;
}

export interface ChatTimelineEntry {
  event: ChatEvent;
  deleted: boolean;
  deletion?: ChatTimelineDeletion;
}

export interface ChatTimelineOptions {
  limit?: number;
}

export interface ChatTimelineSnapshotOptions {
  includeDeleted?: boolean;
  platform?: ChatPlatform;
  channelId?: string;
  channelName?: string;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const dataString = (event: ChatEvent, key: string): string | undefined => {
  const data = asRecord(event.data);
  return typeof data?.[key] === 'string' ? data[key] as string : undefined;
};

const systemKind = (event: ChatEvent): string | undefined => dataString(event, 'kind');

const normalizedName = (value: string | undefined): string | undefined =>
  value?.trim().toLowerCase() || undefined;

const eventChannelId = (event: ChatEvent): string | undefined =>
  event.channelId ?? event.message?.channelId;

const eventChannelName = (event: ChatEvent): string | undefined =>
  event.channelName ?? event.message?.channelName;

const sameChannel = (candidate: ChatEvent, mutation: ChatEvent): boolean => {
  if (candidate.platform !== mutation.platform) return false;

  const mutationId = eventChannelId(mutation);
  const candidateId = eventChannelId(candidate);
  if (mutationId) return candidateId === mutationId;

  const mutationName = normalizedName(eventChannelName(mutation));
  if (mutationName) return normalizedName(eventChannelName(candidate)) === mutationName;

  return true;
};

const targetUserFrom = (event: ChatEvent): Partial<ChatUser> | undefined => {
  if (event.user?.id || event.user?.username) return event.user;
  const id = dataString(event, 'targetUserId');
  const username = dataString(event, 'targetUsername');
  return id || username ? { platform: event.platform, id, username: username ?? '' } : undefined;
};

const sameUser = (candidate: ChatUser, target: Partial<ChatUser>): boolean => {
  if (target.id && candidate.id) return candidate.id === target.id;
  const targetUsername = normalizedName(target.username);
  return Boolean(targetUsername && normalizedName(candidate.username) === targetUsername);
};

const timelineMutation = (event: ChatEvent): ChatTimelineDeletionReason | null => {
  if (event.type === 'message-delete') return 'message-delete';
  if (event.type === 'user-timeout') return 'user-timeout';
  if (event.type === 'user-ban') return 'user-ban';
  if (event.type !== 'system') return null;

  const kind = systemKind(event);
  if (kind === 'chat-clear') return 'chat-clear';
  if (kind === 'chat-clear-user') return 'chat-clear-user';
  return null;
};

const isRenderableTimelineEvent = (event: ChatEvent): boolean => {
  if (timelineMutation(event)) return false;
  switch (event.type) {
    case 'message':
    case 'subscription':
    case 'gift-subscription':
    case 'cheer':
    case 'raid':
    case 'follow':
    case 'donation':
    case 'reward-redemption':
    case 'system':
      return true;
    default:
      return false;
  }
};

const markDeleted = (
  entries: readonly ChatTimelineEntry[],
  event: ChatEvent,
  reason: ChatTimelineDeletionReason,
  predicate: (entry: ChatTimelineEntry) => boolean,
): ChatTimelineEntry[] => entries.map((entry) => {
  if (entry.deleted || !entry.event.message || !predicate(entry)) return entry;
  return {
    ...entry,
    deleted: true,
    deletion: {
      reason,
      timestamp: event.timestamp,
      ...(event.id ? { eventId: event.id } : {}),
    },
  };
});

const applyMutation = (
  entries: readonly ChatTimelineEntry[],
  event: ChatEvent,
  reason: ChatTimelineDeletionReason,
): ChatTimelineEntry[] => {
  if (reason === 'message-delete') {
    const messageId = dataString(event, 'messageId') ?? event.id;
    if (!messageId) return [...entries];
    return markDeleted(entries, event, reason, (entry) =>
      sameChannel(entry.event, event) && entry.event.message?.id === messageId);
  }

  if (reason === 'chat-clear') {
    return markDeleted(entries, event, reason, (entry) => sameChannel(entry.event, event));
  }

  const target = targetUserFrom(event);
  if (!target) return [...entries];
  return markDeleted(entries, event, reason, (entry) =>
    sameChannel(entry.event, event) &&
    Boolean(entry.event.message?.user && sameUser(entry.event.message.user, target)));
};

const insertByTimestamp = (
  entries: readonly ChatTimelineEntry[],
  entry: ChatTimelineEntry,
): ChatTimelineEntry[] => {
  const next = [...entries];
  const index = next.findIndex((candidate) => candidate.event.timestamp > entry.event.timestamp);
  if (index === -1) next.push(entry);
  else next.splice(index, 0, entry);
  return next;
};

const normalizeLimit = (limit: number | undefined): number => {
  const resolved = limit ?? DEFAULT_CHAT_TIMELINE_LIMIT;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new RangeError('ChatTimeline limit must be a positive integer');
  }
  return resolved;
};

const trimToLimit = (
  entries: readonly ChatTimelineEntry[],
  limit: number,
): ChatTimelineEntry[] => entries.length > limit ? entries.slice(entries.length - limit) : [...entries];

export function reduceChatTimeline(
  entries: readonly ChatTimelineEntry[],
  event: ChatEvent,
  options: ChatTimelineOptions = {},
): ChatTimelineEntry[] {
  const limit = normalizeLimit(options.limit);
  const mutation = timelineMutation(event);
  if (mutation) return trimToLimit(applyMutation(entries, event, mutation), limit);
  if (!isRenderableTimelineEvent(event)) return trimToLimit(entries, limit);

  return trimToLimit(insertByTimestamp(entries, {
    event,
    deleted: false,
  }), limit);
}

export function reduceChatEvents(
  events: Iterable<ChatEvent>,
  options: ChatTimelineOptions = {},
): ChatTimelineEntry[] {
  const limit = normalizeLimit(options.limit);
  let entries: ChatTimelineEntry[] = [];
  for (const event of events) {
    entries = reduceChatTimeline(entries, event, { limit });
  }
  return entries;
}

const matchesSnapshotFilter = (
  entry: ChatTimelineEntry,
  options: ChatTimelineSnapshotOptions,
): boolean => {
  if (options.includeDeleted === false && entry.deleted) return false;
  if (options.platform && entry.event.platform !== options.platform) return false;
  if (options.channelId && eventChannelId(entry.event) !== options.channelId) return false;
  if (
    options.channelName &&
    normalizedName(eventChannelName(entry.event)) !== normalizedName(options.channelName)
  ) return false;
  return true;
};

export class ChatTimeline {
  readonly limit: number;
  private entries: ChatTimelineEntry[] = [];

  constructor(options: ChatTimelineOptions = {}) {
    this.limit = normalizeLimit(options.limit);
  }

  get size(): number {
    return this.entries.length;
  }

  apply(event: ChatEvent): ChatTimelineEntry[] {
    this.entries = reduceChatTimeline(this.entries, event, { limit: this.limit });
    return this.snapshot({ includeDeleted: true });
  }

  applyMany(events: Iterable<ChatEvent>): ChatTimelineEntry[] {
    for (const event of events) {
      this.entries = reduceChatTimeline(this.entries, event, { limit: this.limit });
    }
    return this.snapshot({ includeDeleted: true });
  }

  restore(entries: readonly ChatTimelineEntry[]): void {
    const sorted = entries.map((entry) => ({
      ...entry,
      deletion: entry.deletion ? { ...entry.deletion } : undefined,
    })).sort((a, b) => a.event.timestamp - b.event.timestamp);
    this.entries = trimToLimit(sorted, this.limit);
  }

  snapshot(options: ChatTimelineSnapshotOptions = {}): ChatTimelineEntry[] {
    return this.entries
      .filter((entry) => matchesSnapshotFilter(entry, options))
      .map((entry) => ({
        ...entry,
        deletion: entry.deletion ? { ...entry.deletion } : undefined,
      }));
  }

  visibleEvents(options: Omit<ChatTimelineSnapshotOptions, 'includeDeleted'> = {}): ChatEvent[] {
    return this.snapshot({ ...options, includeDeleted: false }).map((entry) => entry.event);
  }

  clear(): void {
    this.entries = [];
  }
}
