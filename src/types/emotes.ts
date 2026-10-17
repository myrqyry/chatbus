export type EmoteProvider =
  | 'twitch'
  | 'twitch-cheer'
  | 'kick'
  | 'youtube'
  | '7tv'
  | 'bttv'
  | 'ffz'
  | 'emoji'
  | 'custom';

export type EmoteScope = 'native' | 'user' | 'channel' | 'global' | 'emoji' | 'custom';
export type EmoteModifier = 'overlay' | 'hidden';
export type EmoteTheme = 'dark' | 'light';

export interface EmoteContentMetadata {
  sexual?: boolean;
  epilepsy?: boolean;
  edgy?: boolean;
  twitchDisallowed?: boolean;
  listed?: boolean;
}

export interface EmoteOverrideMetadata {
  twitchGlobal?: boolean;
  twitchSubscriber?: boolean;
  betterTtv?: boolean;
  frankerFaceZ?: boolean;
}

export interface EmoteAssetOptions {
  /** Prefer animated or static assets when both are available. */
  animated?: boolean;
  /** Prefer a dark/light themed asset while allowing theme-neutral fallbacks. */
  theme?: EmoteTheme;
  /** Preferred formats in descending order, for example ['avif', 'webp']. */
  preferredFormats?: readonly string[];
  /** Prefer the closest declared provider scale. */
  scale?: number;
  /** Prefer the smallest known asset that meets this intrinsic width. */
  targetWidth?: number;
  /** Prefer the smallest known asset that meets this intrinsic height. */
  targetHeight?: number;
}

export interface EmoteImage {
  url: string;
  width?: number;
  height?: number;
  format?: string;
  scale?: number;
  animated?: boolean;
  theme?: EmoteTheme;
}

export interface Emote {
  code: string;
  id: string;
  url: string;
  altUrls?: string[];
  zeroWidth: boolean;
  provider: EmoteProvider;
  animated?: boolean;
  ownerName?: string;
  images?: EmoteImage[];
  modifier?: EmoteModifier;
  /** FFZ modifier_flags: provider-defined bitset, preserved for consumer effects. */
  modifierFlags?: number;
  content?: EmoteContentMetadata;
  overrides?: EmoteOverrideMetadata;
  raw?: unknown;
}

export interface EmoteCandidate extends Emote {
  scope: EmoteScope;
}

export type EmoteSet = Record<string, Emote>;

export interface ProviderStatus {
  provider: EmoteProvider;
  scope: 'channel' | 'global';
  ok: boolean;
  count: number;
  error?: string;
}

export interface EmoteFetchResult {
  emotes: EmoteSet;
  providers: ProviderStatus[];
  fromCache: boolean;
  complete: boolean;
  /** Provider candidates retained so live provider updates can re-run deterministic precedence. */
  candidates?: EmoteCandidate[];
}

export interface EmoteFetchOptions {
  bypassCache?: boolean;
  signal?: AbortSignal;
}

export interface MergeCandidatesOptions {
  /** Provider priority is consulted only after scope priority ties. */
  providerPriority?: Partial<Record<EmoteProvider, number>>;
  /** Scope priority is the primary normal collision rule. */
  scopePriority?: Partial<Record<EmoteScope, number>>;
}
