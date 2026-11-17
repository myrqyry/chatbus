// Server-only: verify the raw delivery before normalizing official Kick events.
import { createPublicKey, verify, constants } from 'node:crypto';
import type { ChatEvent, ChatUser, ChatMessage } from '../../types/chat';
import type { EmoteSet } from '../../types/emotes';
import { parseMessageFragments } from '../../messages/parse';
import { parseKickMessageContent } from './emotes';

const keyUrl = 'https://api.kick.com/public/v1/public-key';
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function rsaKey(pem: string) {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'rsa') throw new Error('Expected a Kick RSA public key');
  return key;
}

/** Obtain the current key from Kick. Host owns cache/rotation and retry policies. */
export async function fetchKickWebhookPublicKey(options: { fetcher?: typeof fetch; signal?: AbortSignal } = {}): Promise<string> {
  const timeout = AbortSignal.timeout(5000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await (options.fetcher ?? fetch)(keyUrl, { signal });
  if (!response.ok) throw new Error('Kick public key request failed (' + response.status + ')');
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !isRecord(payload.data) || !isText(payload.data.public_key)) {
    throw new Error('Invalid Kick public key response');
  }
  rsaKey(payload.data.public_key);
  return payload.data.public_key;
}

export interface KickChatWebhookInput {
  body: Uint8Array;
  headers: Pick<Headers, 'get'>;
  publicKey: string;
  /** Host-owned registration, not a value copied from the incoming headers. */
  subscriptionId: string;
  broadcasterUserId: number;
  emotes?: EmoteSet;
}

export interface VerifiedKickChatDelivery {
  deliveryId: string;
  deliveredAt: number;
  event: ChatEvent;
}

/** Stateless verification only. Host MUST enforce freshness and durable delivery-ID deduplication before dispatch. */
export function verifyKickChatWebhook(input: KickChatWebhookInput): VerifiedKickChatDelivery {
  const { body, headers } = input;
  const required = (name: string) => {
    const value = headers.get('Kick-Event-' + name);
    if (!value) throw new Error('Missing Kick webhook ' + name);
    return value;
  };
  if (!isId(input.broadcasterUserId) || !input.subscriptionId) throw new Error('Invalid expected Kick subscription');
  if (body.byteLength > 256 * 1024) throw new Error('Kick webhook body exceeds limit');
  const id = required('Message-Id'), time = required('Message-Timestamp');
  const signature = required('Signature'), deliveredAt = Date.parse(time);
  if (id.length > 128 || time.length > 128 || !Number.isFinite(deliveredAt) ||
      signature.length > 2048 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
    throw new Error('Invalid Kick webhook signature metadata');
  }
  const signed = Buffer.concat([Buffer.from(id + '.' + time + '.'), body]);
  if (!verify('RSA-SHA256', signed, { key: rsaKey(input.publicKey), padding: constants.RSA_PKCS1_PADDING }, Buffer.from(signature, 'base64'))) {
    throw new Error('Invalid Kick webhook signature');
  }
  if (required('Subscription-Id') !== input.subscriptionId) throw new Error('Unexpected Kick webhook subscription');
  if (required('Type') !== 'chat.message.sent' || required('Version') !== '1') throw new Error('Unsupported Kick webhook type/version');
  const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  if (!isRecord(payload) || !isText(payload.message_id) || typeof payload.content !== 'string' ||
      !isText(payload.created_at) || !Number.isFinite(Date.parse(payload.created_at)) ||
      !isRecord(payload.sender) || !isId(payload.sender.user_id) || !isText(payload.sender.username) ||
      !isRecord(payload.broadcaster) || !isId(payload.broadcaster.user_id)) {
    throw new Error('Invalid Kick chat webhook payload');
  }
  if (payload.broadcaster.user_id !== input.broadcasterUserId) throw new Error('Unexpected Kick webhook broadcaster');
  const channelId = String(payload.broadcaster.user_id);
  const channelName = isText(payload.broadcaster.channel_slug) ? payload.broadcaster.channel_slug : undefined;
  const sender = payload.sender;
  const identity = isRecord(sender.identity) ? sender.identity : undefined;
  const badgeRefs = Array.isArray(identity?.badges) ? identity.badges.flatMap(badge =>
    isRecord(badge) && isText(badge.type) ? [{
      provider: 'kick' as const, id: badge.type,
      version: typeof badge.count === 'number' ? String(badge.count) : undefined,
      info: typeof badge.text === 'string' ? badge.text : undefined,
    }] : []) : [];
  const user: ChatUser = {
    platform: 'kick', id: String(sender.user_id), username: sender.username as string,
    displayName: sender.username as string,
    color: typeof identity?.username_color === 'string' ? identity.username_color : undefined,
    roles: badgeRefs.length ? badgeRefs.map(b => b.id) : undefined,
    badgeRefs: badgeRefs.length ? badgeRefs : undefined, raw: sender,
  };
  const parsed = parseKickMessageContent(payload.content);
  const parent = isRecord(payload.replies_to) ? payload.replies_to : undefined;
  const parentSender = isRecord(parent?.sender) ? parent.sender : undefined;
  const parentId = isText(parent?.message_id) ? parent.message_id : undefined;
  const timestamp = Date.parse(payload.created_at);
  const message: ChatMessage = {
    id: payload.message_id, platform: 'kick', channelId, channelName, user,
    text: parsed.text, fragments: parseMessageFragments(parsed.text, { nativeEmotes: parsed.nativeEmotes, emotes: input.emotes }),
    timestamp, replyToMessageId: parentId,
    reply: parentId ? {
      parentMessageId: parentId,
      parentMessageBody: typeof parent?.content === 'string' ? parent.content : undefined,
      parentUserId: isId(parentSender?.user_id) ? String(parentSender.user_id) : undefined,
      parentUsername: isText(parentSender?.username) ? parentSender.username : undefined,
    } : undefined, raw: payload,
  };
  return { deliveryId: id, deliveredAt, event: {
    id: message.id, type: 'message', platform: 'kick', channelId, channelName,
    timestamp, origin: 'live', user, message, raw: payload,
  } };
}
