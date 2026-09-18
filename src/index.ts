export type {
  Emote,
  EmoteAssetOptions,
  EmoteCandidate,
  EmoteContentMetadata,
  EmoteFetchOptions,
  EmoteFetchResult,
  EmoteImage,
  EmoteModifier,
  EmoteOverrideMetadata,
  EmoteProvider,
  EmoteScope,
  EmoteSet,
  EmoteTheme,
  MergeCandidatesOptions,
  ProviderStatus,
} from './types/emotes';
export type {
  Badge,
  BadgeImage,
  BadgeProvider,
  BadgeRef,
  BadgeScope,
  EnrichmentResult,
  IdentityFetchOptions,
  NamePaint,
  NamePaintGradient,
  NamePaintShadow,
  NamePaintStop,
  UserCosmetics,
} from './types/identity';
export type {
  ChatConnectionState,
  ChatEvent,
  ChatEventOrigin,
  ChatEventType,
  ChatFragment,
  ChatMessage,
  ChatMessageReply,
  ChatMessageSource,
  ChatMessageTraits,
  ChatPlatform,
  ChatUser,
  CheermoteFragment,
  EmoteFragment,
  HypeTrainContribution,
  HypeTrainData,
  HypeTrainPhase,
  HypeTrainSharedParticipant,
  MediaFragment,
  MentionFragment,
  ModifierFragment,
  NativeEmoteSpan,
  ParseMessageOptions,
  TextFragment,
  UnknownFragment,
} from './types/chat';
export { mergeCandidates } from './emotes/registry';
export { emoteAssetCandidates, resolveEmoteAsset } from './emotes/assets';
export { parseMessageFragments, twitchEmoteSpansFromTag } from './messages/parse';
export {
  createTwitchNativeEmote,
  resolveTwitchEmoteAsset,
  twitchEmoteImages,
  TWITCH_EMOTE_CDN_TEMPLATE,
} from './emotes/twitchAssets';
export type {
  TwitchEmoteAssetDescriptor,
  TwitchEmoteAssetOptions,
  TwitchEmoteFormat,
  TwitchEmoteScale,
} from './emotes/twitchAssets';
export {
  clearBadgeCaches,
  fetchBttvBadgesForUser,
  fetchBttvBadgesForUserDetailed,
  fetchFfzBadgesForUser,
  fetchFfzBadgesForUserDetailed,
  fetchTwitchChannelBadgesDetailed,
  fetchTwitchGlobalBadgesDetailed,
  IDENTITY_BADGE_CACHE_MS,
  mergeBadges,
  parseTwitchBadgeRefs,
  resolveBadgeRefs,
} from './identity/badges';
export type { TwitchBadgeApiOptions } from './identity/badges';
export {
  clearSevenTvUserCosmeticsCache,
  fetchSevenTvUserCosmetics,
  fetchSevenTvUserCosmeticsDetailed,
  SEVEN_TV_COSMETICS_CACHE_MS,
} from './identity/sevenTv';
export { fetchJson, fetchWithTimeout, isAbortError } from './network/fetch';
export { resolveTwitchUserId } from './emotes/twitch';
export {
  fetchChannelSevenTv,
  fetchGlobalSevenTv,
  fetchKickChannelSevenTv,
  fetchSevenTvChannelSnapshot,
  fetchSevenTvEmoteSet,
  sevenTvCandidateFromActiveEmote,
  sevenTvCandidatesFromActiveEmotes,
  sevenTvOverridesFromActiveEmote,
  SEVEN_TV_ACTIVE_EMOTE_FLAGS,
} from './emotes/sevenTv';
export type {
  SevenTvActiveEmote,
  SevenTvChannelSnapshot,
  SevenTvEmoteScope,
  SevenTvPlatform,
} from './emotes/sevenTv';
export { fetchChannelBttv, fetchGlobalBttv } from './emotes/bttv';
export { fetchChannelFfz, fetchGlobalFfz } from './emotes/ffz';
export { fetchChannelEmotes, fetchChannelEmotesDetailed } from './emotes/loader';
export { CACHE_DURATION_MS, clearCachedEmotes } from './emotes/cache';
export type { ProviderOptions, ProviderResult } from './types/providers';


export { createChatBus } from './bus';
export type {
  ChatBus,
  ChatBusConnectionHandle,
  ChatBusConnectionSpec,
  ChatBusConnectionState,
  ChatBusErrorContext,
  ChatBusOptions,
} from './bus';

export {
  ChatTimeline,
  DEFAULT_CHAT_TIMELINE_LIMIT,
  reduceChatEvents,
  reduceChatTimeline,
} from './timeline';
export type {
  ChatTimelineDeletion,
  ChatTimelineDeletionReason,
  ChatTimelineEntry,
  ChatTimelineOptions,
  ChatTimelineSnapshotOptions,
} from './timeline';

export {
  ChatEventRecorder,
  chatEventOrigin,
  createTestChatEvent,
  createTestMessageEvent,
  deserializeChatEvent,
  deserializeChatEvents,
  isChatEvent,
  replayChatEvent,
  serializeChatEvent,
  serializeChatEvents,
} from './testing/events';
export type {
  ChatEventRecorderOptions,
  TestMessageEventOptions,
} from './testing/events';

export { resolveKickChannel } from './platforms/kick/channel';
export type { ResolveKickChannelOptions } from './platforms/kick/channel';
export { connectKickChat } from './platforms/kick/connect';
export { kickEmoteUrl, parseKickMessageContent } from './platforms/kick/emotes';
export type { ParsedKickMessageContent } from './platforms/kick/emotes';
export { normalizeKickEvent } from './platforms/kick/normalize';
export { parseKickPusherFrame } from './platforms/kick/protocol';
export { createKickSocket, kickReconnectDelay } from './platforms/kick/socket';
export type {
  KickChannelInfo,
  KickChannelSubscriptionPayload,
  KickChatConnection,
  KickChatMessagePayload,
  KickConnectOptions,
  KickGiftedSubscriptionsPayload,
  KickLuckyGiftedSubscriptionsPayload,
  KickMessageDeletedPayload,
  KickNormalizeContext,
  KickPinnedMessagePayload,
  KickPollDeletePayload,
  KickPollUpdatePayload,
  KickProtocolDataByType,
  KickProtocolEvent,
  KickResolvedChannel,
  KickSender,
  KickSenderIdentity,
  KickSocketHandle,
  KickSocketOptions,
  KickStreamHostPayload,
  KickSubscriptionPayload,
  KickUserBannedPayload,
  KickUserUnbannedPayload,
} from './platforms/kick/types';

export {
  SevenTvEntitlementStore,
  sevenTvEntitlementsFromDispatch,
} from './seventv/entitlements';
export type {
  SevenTvEntitlement,
  SevenTvEntitlementApplyResult,
  SevenTvEntitlementKind,
  SevenTvEntitlementLoadError,
  SevenTvEntitlementStoreOptions,
} from './seventv/entitlements';
export {
  applySevenTvEmoteSetDispatch,
  connectSevenTvLive,
  replaceSevenTvChannelCandidates,
} from './seventv/live';
export {
  parseSevenTvDispatch,
  parseSevenTvEventFrame,
  parseSevenTvHello,
  sevenTvSubscribeFrame,
  sevenTvUnsubscribeFrame,
} from './seventv/protocol';
export {
  createSevenTvEventSocket,
  sevenTvReconnectDelay,
  shouldReconnectSevenTv,
} from './seventv/socket';
export type {
  SevenTvChangeField,
  SevenTvChangeMap,
  SevenTvDispatch,
  SevenTvEmoteSetPatchResult,
  SevenTvEntitlementChangeInfo,
  SevenTvEventEnvelope,
  SevenTvEventSocketHandle,
  SevenTvEventSocketOptions,
  SevenTvHelloPayload,
  SevenTvLiveConnection,
  SevenTvLiveConnectOptions,
  SevenTvSubscription,
} from './seventv/types';

export {
  resolveTwitchChannel,
  resolveTwitchEventSubAuth,
  validateTwitchUserAccessToken,
} from './platforms/twitch/auth';
export {
  planTwitchCapabilities,
  TWITCH_CAPABILITY_REGISTRY,
} from './platforms/twitch/capabilities';
export type {
  TwitchCapabilityDefinition,
  TwitchCapabilityId,
  TwitchCapabilityPlan,
  TwitchCapabilityPlanOptions,
  TwitchCapabilityStatus,
  TwitchCapabilitySubscriptionDefinition,
  TwitchEventSubConditionKind,
  TwitchPlannedSubscription,
  TwitchScopeRequirement,
} from './platforms/twitch/capabilities';
export {
  clearTwitchCheermoteCache,
  fetchTwitchCheermotes,
  resolveTwitchCheermote,
  TWITCH_CHEERMOTE_CACHE_MS,
} from './platforms/twitch/cheermotes';
export {
  fetchTwitchChannelEmoteCatalog,
  fetchTwitchEmoteCatalog,
  fetchTwitchGlobalEmoteCatalog,
  twitchCatalogEntryToCandidate,
} from './platforms/twitch/emotes';
export type {
  TwitchEmoteCatalog,
  TwitchEmoteCatalogEntry,
  TwitchEmoteCatalogFetchOptions,
} from './platforms/twitch/emotes';
export { connectTwitchChat } from './platforms/twitch/connect';
export { normalizeTwitchHypeTrainEvent } from './platforms/twitch/hypeTrain';
export {
  isTwitchMessageEmoteOnly,
  normalizeTwitchMessageFragments,
} from './platforms/twitch/message';
export { normalizeTwitchEventSubNotification } from './platforms/twitch/normalize';
export { parseTwitchEventSubFrame } from './platforms/twitch/protocol';
export { createTwitchEventSubSocket, twitchReconnectDelay } from './platforms/twitch/socket';
export {
  createTwitchEventSubSubscription,
  DEFAULT_TWITCH_CHAT_SUBSCRIPTIONS,
  subscribeTwitchChat,
  twitchSubscriptionMissingScopeRequirements,
  twitchSubscriptionRequiredScopes,
  twitchSubscriptionScopeRequirements,
  TWITCH_FOLLOW_SUBSCRIPTIONS,
  TWITCH_HYPE_TRAIN_SUBSCRIPTIONS,
  TWITCH_MODERATION_SUBSCRIPTIONS,
  TWITCH_REWARD_SUBSCRIPTIONS,
  TWITCH_STATE_SUBSCRIPTIONS,
} from './platforms/twitch/subscriptions';
export type {
  TwitchAuth,
  TwitchChatConnection,
  TwitchChatMessagePayload,
  TwitchChatSubscriptionType,
  TwitchCheermoteDefinition,
  TwitchCheermoteImageTheme,
  TwitchCheermoteSet,
  TwitchCheermoteTier,
  TwitchConnectOptions,
  TwitchEventSubEnvelope,
  TwitchEventSubMetadata,
  TwitchEventSubSession,
  TwitchEventSubSocketHandle,
  TwitchEventSubSocketOptions,
  TwitchEventSubSubscription,
  TwitchEventSubSubscriptionType,
  TwitchFollowerSubscriptionType,
  TwitchHypeTrainSubscriptionType,
  TwitchModerationSubscriptionType,
  TwitchRewardSubscriptionType,
  TwitchStateSubscriptionType,
  TwitchMessageFragmentPayload,
  TwitchNormalizeContext,
  TwitchNormalizedMessage,
  TwitchResolvedChannel,
  TwitchSubscriptionStateChange,
  TwitchTokenValidation,
} from './platforms/twitch/types';


export { connectYouTubeChat, resolveYouTubeLiveChat } from './platforms/youtube/connect';
export { normalizeYouTubeLiveChatMessage } from './platforms/youtube/normalize';
export type {
  YouTubeChatConnection,
  YouTubeConnectOptions,
  YouTubeLiveChatAuthorDetails,
  YouTubeLiveChatListResponse,
  YouTubeLiveChatMessageResource,
  YouTubeLiveChatMessageSnippet,
  YouTubeNormalizeContext,
  YouTubeResolvedLiveChat,
  YouTubeSuperChatDetails,
  YouTubeSuperStickerDetails,
} from './platforms/youtube/types';
