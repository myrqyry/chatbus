import type { ChatConnectionState, ChatEvent } from '../../types/chat';

export interface YouTubeLiveChatAuthorDetails {
  channelId?: string;
  displayName?: string;
  profileImageUrl?: string;
  isVerified?: boolean;
  isChatOwner?: boolean;
  isChatSponsor?: boolean;
  isChatModerator?: boolean;
}

export interface YouTubeSuperChatDetails {
  amountMicros?: string;
  currency?: string;
  amountDisplayString?: string;
  userComment?: string;
  tier?: number;
}

export interface YouTubeSuperStickerDetails {
  amountMicros?: string;
  currency?: string;
  amountDisplayString?: string;
  tier?: number;
  superStickerMetadata?: {
    stickerId?: string;
    altText?: string;
    language?: string;
  };
}

export interface YouTubeLiveChatMessageSnippet {
  type?: string;
  liveChatId?: string;
  authorChannelId?: string;
  publishedAt?: string;
  hasDisplayContent?: boolean;
  displayMessage?: string;
  textMessageDetails?: { messageText?: string };
  superChatDetails?: YouTubeSuperChatDetails;
  superStickerDetails?: YouTubeSuperStickerDetails;
  newSponsorDetails?: {
    memberLevelName?: string;
    isUpgrade?: boolean;
  };
  memberMilestoneChatDetails?: {
    userComment?: string;
    memberMonth?: number;
    memberLevelName?: string;
  };
  membershipGiftingDetails?: {
    giftMembershipsCount?: number;
    giftMembershipsLevelName?: string;
  };
  giftMembershipReceivedDetails?: {
    memberLevelName?: string;
    gifterChannelId?: string;
    associatedMembershipGiftingMessageId?: string;
  };
  messageDeletedDetails?: { deletedMessageId?: string };
  userBannedDetails?: {
    bannedUserDetails?: YouTubeLiveChatAuthorDetails;
    banType?: string;
    banDurationSeconds?: string | number;
  };
  pollDetails?: unknown;
  giftEventDetails?: {
    giftMetadata?: {
      jewelsAmount?: number;
      giftName?: string;
      giftUrl?: string;
      giftDuration?: { seconds?: number; nanos?: number };
      hasVisualEffect?: boolean;
      comboCount?: number;
      altText?: string;
      language?: string;
    };
  };
}

export interface YouTubeLiveChatMessageResource {
  id: string;
  snippet?: YouTubeLiveChatMessageSnippet;
  authorDetails?: YouTubeLiveChatAuthorDetails;
}

export interface YouTubeLiveChatListResponse {
  nextPageToken?: string;
  pollingIntervalMillis?: number;
  offlineAt?: string;
  items?: YouTubeLiveChatMessageResource[];
  activePollItem?: YouTubeLiveChatMessageResource;
}

export interface YouTubeResolvedLiveChat {
  videoId?: string;
  liveChatId: string;
  channelId?: string;
  channelName?: string;
}

export interface YouTubeNormalizeContext {
  liveChatId?: string;
  videoId?: string;
  channelId?: string;
  channelName?: string;
  now?: () => number;
}

export interface YouTubeConnectOptions {
  videoId?: string;
  liveChatId?: string;
  apiKey?: string;
  accessToken?: string;
  channelId?: string;
  channelName?: string;
  maxResults?: number;
  profileImageSize?: number;
  emitInitialHistory?: boolean;
  signal?: AbortSignal;
  onEvent: (event: ChatEvent) => void;
  onStateChange?: (state: ChatConnectionState) => void;
  onError?: (error: Error) => void;
}

export interface YouTubeChatConnection {
  liveChat: YouTubeResolvedLiveChat;
  close: () => void;
}
