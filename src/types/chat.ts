import type { Emote, EmoteSet } from './emotes';
import type { Badge, BadgeRef, NamePaint } from './identity';

export type ChatPlatform = 'twitch' | 'kick' | 'youtube' | 'custom';
export type ChatEventOrigin = 'live' | 'replay' | 'test';
export type ChatConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

export interface ChatUser {
  platform: ChatPlatform;
  id?: string;
  username: string;
  displayName?: string;
  color?: string;
  roles?: string[];
  badgeRefs?: BadgeRef[];
  badges?: Badge[];
  namePaint?: NamePaint;
  raw?: unknown;
}

export interface NativeEmoteSpan {
  id: string;
  start: number;
  end: number;
  provider?: Emote['provider'];
  emote?: Emote;
}

export interface TextFragment {
  type: 'text';
  text: string;
}

export interface EmoteFragment {
  type: 'emote';
  text: string;
  emote: Emote;
  overlays: Emote[];
  modifiers: Emote[];
}

export interface ModifierFragment {
  type: 'modifier';
  text: string;
  emote: Emote;
}

export interface MentionFragment {
  type: 'mention';
  text: string;
  username?: string;
  userId?: string;
}

export interface CheermoteFragment {
  type: 'cheermote';
  text: string;
  bits: number;
  prefix?: string;
  tier?: number;
  emote?: Emote;
}

export interface MediaFragment {
  type: 'media';
  text: string;
  mediaType: 'gif' | 'image';
  id?: string;
  url: string;
  alt?: string;
  raw?: unknown;
}

export interface UnknownFragment {
  type: 'unknown';
  text: string;
  raw?: unknown;
}

export type ChatFragment =
  | TextFragment
  | EmoteFragment
  | ModifierFragment
  | MentionFragment
  | CheermoteFragment
  | MediaFragment
  | UnknownFragment;

export interface ChatMessageTraits {
  messageType?: string;
  highlighted?: boolean;
  firstMessage?: boolean;
  emoteOnly?: boolean;
  customRewardId?: string;
}

export interface ChatMessageReply {
  parentMessageId?: string;
  parentMessageBody?: string;
  parentUserId?: string;
  parentUsername?: string;
  parentDisplayName?: string;
  threadMessageId?: string;
  threadUserId?: string;
  threadUsername?: string;
  threadDisplayName?: string;
}

export interface ChatMessageSource {
  channelId?: string;
  channelName?: string;
  displayName?: string;
  messageId?: string;
  badgeRefs?: BadgeRef[];
  sourceOnly?: boolean;
}

export interface ChatMessage {
  id: string;
  platform: ChatPlatform;
  channelId?: string;
  channelName?: string;
  user: ChatUser;
  text: string;
  fragments: ChatFragment[];
  timestamp: number;
  replyToMessageId?: string;
  reply?: ChatMessageReply;
  source?: ChatMessageSource;
  traits?: ChatMessageTraits;
  raw?: unknown;
}

export type HypeTrainPhase = 'begin' | 'progress' | 'end';

export interface HypeTrainContribution {
  userId?: string;
  username?: string;
  displayName?: string;
  type: string;
  total: number;
}

export interface HypeTrainSharedParticipant {
  broadcasterUserId: string;
  broadcasterUsername?: string;
  broadcasterDisplayName?: string;
}

export interface HypeTrainData {
  phase: HypeTrainPhase;
  id: string;
  total: number;
  level: number;
  progress?: number;
  goal?: number;
  topContributions: HypeTrainContribution[];
  lastContribution?: HypeTrainContribution;
  startedAt?: string;
  expiresAt?: string;
  endedAt?: string;
  cooldownEndsAt?: string;
  trainType?: string;
  isSharedTrain?: boolean;
  sharedTrainParticipants?: HypeTrainSharedParticipant[];
  allTimeHighLevel?: number;
  allTimeHighTotal?: number;
}

export type ChatEventType =
  | 'message'
  | 'message-delete'
  | 'user-timeout'
  | 'user-ban'
  | 'subscription'
  | 'gift-subscription'
  | 'cheer'
  | 'raid'
  | 'follow'
  | 'donation'
  | 'channel-update'
  | 'reward-redemption'
  | 'room-state'
  | 'hype-train'
  | 'stream-online'
  | 'stream-offline'
  | 'system';

export interface ChatEvent<T = unknown> {
  id?: string;
  type: ChatEventType;
  platform: ChatPlatform;
  channelId?: string;
  channelName?: string;
  timestamp: number;
  origin?: ChatEventOrigin;
  user?: ChatUser;
  message?: ChatMessage;
  data?: T;
  raw?: unknown;
}

export interface ParseMessageOptions {
  emotes?: EmoteSet;
  nativeEmotes?: NativeEmoteSpan[];
}
