import type { ChatEvent, ChatEventType, ChatPlatform, ChatUser } from '../../types/chat';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : null;
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;
const identifier = (value: unknown): string | undefined =>
  str(value) ?? (typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value) : undefined);

const accountPlatform = (account: unknown): ChatPlatform => {
  switch (account) {
    case 'twitch_account': return 'twitch';
    case 'youtube_account': return 'youtube';
    default: return 'custom';
  }
};

export interface StreamlabsAuxiliaryEvent {
  kind: 'alert-playing' | 'streamlabels' | 'volume' | 'credits' | 'donation-delete';
  type: string;
  account?: string;
  timestamp: number;
  data: unknown;
  raw: unknown;
}

export interface StreamlabsUnknownEvent {
  reason: 'invalid-envelope' | 'unsupported-type' | 'invalid-message';
  raw: unknown;
}

export interface StreamlabsParseResult {
  events: ChatEvent[];
  auxiliary: StreamlabsAuxiliaryEvent[];
  unknown: StreamlabsUnknownEvent[];
}

export interface StreamlabsNormalizeOptions {
  timestamp?: number;
  channelName?: string;
}

// Streamlabs batches envelopes and may put multiple individual interactions in one "message" array.
// A transport envelope ID alone is NOT a unique interaction ID.
export function normalizeStreamlabsPayload(
  payload: unknown,
  options: StreamlabsNormalizeOptions = {},
): StreamlabsParseResult {
  const result: StreamlabsParseResult = { events: [], auxiliary: [], unknown: [] };
  const fallbackTime = options.timestamp ?? Date.now();
  let decoded = payload;
  if (typeof decoded === 'string') {
    try { decoded = JSON.parse(decoded) as unknown; }
    catch {
      result.unknown.push({ reason: 'invalid-envelope', raw: payload });
      return result;
    }
  }
  if (!Array.isArray(decoded)) {
    result.unknown.push({ reason: 'invalid-envelope', raw: decoded });
    return result;
  }

  for (const raw of decoded) {
    const envelope = record(raw);
    const type = str(envelope?.type);
    if (!envelope || !type) {
      result.unknown.push({ reason: 'invalid-envelope', raw });
      continue;
    }
    const account = str(envelope.for);
    const platform = accountPlatform(account);
    const auxiliaryKind: StreamlabsAuxiliaryEvent['kind'] | undefined = ({
      alertPlaying: 'alert-playing',
      'subscription-playing': 'alert-playing',
      streamlabels: 'streamlabels',
      'streamlabels.underlying': 'streamlabels',
      muteVolume: 'volume',
      rollEndCredits: 'credits',
      donationDelete: 'donation-delete',
    } as Record<string, StreamlabsAuxiliaryEvent['kind']>)[type];
    if (auxiliaryKind) {
      result.auxiliary.push({
        kind: auxiliaryKind, type, account, timestamp: fallbackTime, data: envelope.message, raw,
      });
      continue;
    }

    const mappedType: ChatEventType | undefined = ({
      donation: 'donation',
      bits: 'cheer',
      raid: 'raid',
      follow: 'follow',
      subscription: 'subscription',
      subMysteryGift: 'gift-subscription',
      superchat: 'donation',
    } as Record<string, ChatEventType>)[type];
    if (!mappedType) {
      result.unknown.push({ reason: 'unsupported-type', raw });
      continue;
    }
    if (!Array.isArray(envelope.message)) {
      result.unknown.push({ reason: 'invalid-message', raw });
      continue;
    }

    const envelopeId = identifier(envelope.event_id);
    for (const [index, item] of envelope.message.entries()) {
      const message = record(item);
      if (!message) {
        result.unknown.push({ reason: 'invalid-message', raw: item });
        continue;
      }
      const itemId = identifier(message._id) ?? identifier(message.event_id)
        ?? identifier(message.id);
      const stablePart = itemId ?? (envelopeId ? `${envelopeId}:${index}` : undefined);
      const id = stablePart ? `streamlabs:${account ?? 'unknown'}:${type}:${stablePart}` : undefined;
      const name = str(message.from) ?? str(message.name);
      const user: ChatUser | undefined = name ? {
        platform, username: name, displayName: str(message.display_name) ?? name,
        id: identifier(message.from_user_id) ?? identifier(message.subscriber_twitch_id),
      } : undefined;
      const timestamp = typeof message.createdAtTimestamp === 'number' &&
        Number.isFinite(message.createdAtTimestamp) && message.createdAtTimestamp > 0
        ? message.createdAtTimestamp : fallbackTime;
      const gifted = type === 'subMysteryGift' ||
        (type === 'subscription' && /gift/i.test(str(message.sub_type) ?? ''));
      const eventType = gifted ? 'gift-subscription' : mappedType;
      result.events.push({
        id, type: eventType, platform, channelName: options.channelName,
        timestamp, origin: 'live', user,
        data: {
          source: 'streamlabs',
          sourceAccount: account,
          sourceType: type,
          streamlabsEventId: envelopeId,
          streamlabsMessageId: itemId,
          // Monetary values intentionally stay as received (decimal strings or platform units).
          amount: message.amount,
          currency: message.currency,
          formattedAmount: message.formatted_amount ?? message.displayString,
          text: message.message ?? message.comment,
          bits: type === 'bits' ? message.amount : undefined,
          months: message.months,
          giftType: message.sub_type,
          recipients: message.gifts,
        },
        raw: { envelope, message },
      });
    }
  }
  return result;
}
