import type { ChatEvent, ChatConnectionState } from '../../types/chat';
import type { EmoteSet } from '../../types/emotes';

export interface KickChannelInfo {
  id?: number;
  slug?: string;
  chatroom?: { id?: number };
  [key: string]: unknown;
}

export interface KickResolvedChannel {
  channelName: string;
  channelId?: string;
  chatroomId: number;
  raw?: unknown;
}

export interface KickSenderIdentity {
  color?: string | null;
  badges?: unknown;
  badges_v2?: unknown;
}

export interface KickSender {
  id: number | string;
  username: string;
  slug?: string;
  identity?: KickSenderIdentity;
}

export interface KickChatMessagePayload {
  id: string;
  chatroom_id: number;
  content: string;
  type?: string;
  created_at: string;
  sender: KickSender;
  metadata?: unknown;
}

export interface KickSubscriptionPayload {
  chatroom_id?: number;
  username: string;
  months?: number;
}

export interface KickGiftedSubscriptionsPayload {
  chatroom_id?: number;
  gifted_usernames?: string[];
  gifter_username?: string;
}

export interface KickChannelSubscriptionPayload {
  id?: string | number;
  username?: string;
  user?: { id?: string | number; username?: string; slug?: string };
  subscriber?: { id?: string | number; username?: string; slug?: string };
  [key: string]: unknown;
}

export interface KickLuckyGiftedSubscriptionsPayload {
  id?: string | number;
  gifted_usernames?: string[];
  gifter_username?: string;
  [key: string]: unknown;
}

export interface KickStreamHostPayload {
  chatroom_id?: number;
  optional_message?: string;
  number_viewers?: number;
  host_username?: string;
}

export interface KickMessageDeletedPayload {
  id?: string;
  message?: { id?: string };
}

export interface KickUserBannedPayload {
  id?: string;
  user?: { id?: number | string; username?: string; slug?: string };
  banned_by?: { id?: number | string; username?: string; slug?: string };
  expires_at?: string | null;
}

export interface KickUserUnbannedPayload {
  id?: string;
  user?: { id?: number | string; username?: string; slug?: string };
  unbanned_by?: { id?: number | string; username?: string; slug?: string };
}

export interface KickPinnedMessagePayload {
  message?: KickChatMessagePayload;
  duration?: number;
}

export interface KickPollUpdatePayload {
  poll?: unknown;
}

export interface KickPollDeletePayload {
  poll_id?: string;
}

export interface KickProtocolDataByType {
  ChatMessage: KickChatMessagePayload;
  Subscription: KickSubscriptionPayload;
  GiftedSubscriptions: KickGiftedSubscriptionsPayload;
  ChannelSubscription: KickChannelSubscriptionPayload;
  LuckyGiftedSubscriptions: KickLuckyGiftedSubscriptionsPayload;
  StreamHost: KickStreamHostPayload;
  MessageDeleted: KickMessageDeletedPayload;
  UserBanned: KickUserBannedPayload;
  UserUnbanned: KickUserUnbannedPayload;
  PinnedMessageCreated: KickPinnedMessagePayload;
  PinnedMessageDeleted: KickMessageDeletedPayload;
  PollUpdate: KickPollUpdatePayload;
  PollDelete: KickPollDeletePayload;
}

export type KickProtocolEvent = {
  [K in keyof KickProtocolDataByType]: { type: K; data: KickProtocolDataByType[K] };
}[keyof KickProtocolDataByType];

export interface KickNormalizeContext {
  channelName?: string;
  channelId?: string;
  emotes?: EmoteSet;
  now?: () => number;
}

export interface KickSocketOptions {
  appKey?: string;
  baseUrl?: string;
  inactivityTimeoutMs?: number;
  channelId?: string;
  additionalChannels?: string[];
  onOpen?: () => void;
  onMessage?: (message: string) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
  onStateChange?: (state: ChatConnectionState) => void;
}

export interface KickSocketHandle {
  close: () => void;
}

export interface KickConnectOptions {
  channel: string;
  chatroomId?: number;
  channelId?: string;
  emotes?: EmoteSet;
  getEmotes?: () => EmoteSet;
  signal?: AbortSignal;
  resolveChannel?: (channel: string, signal?: AbortSignal) => Promise<KickResolvedChannel>;
  socket?: Omit<KickSocketOptions, 'onOpen' | 'onMessage' | 'onClose' | 'onError' | 'onStateChange'>;
  onEvent: (event: ChatEvent) => void;
  onStateChange?: (state: ChatConnectionState) => void;
  onError?: (error: Error) => void;
}

export interface KickChatConnection {
  channel: KickResolvedChannel;
  close: () => void;
}
