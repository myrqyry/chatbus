# Emote precedence and asset resolution

This document is the current contract for resolving emote collisions and choosing renderer-facing image assets. Provider adapters preserve enough metadata for applications to make presentation choices without duplicating provider-specific rules.

## Collision precedence

`mergeCandidates()` resolves ordinary collisions lexicographically rather than adding scope and provider scores together.

Normal scope priority is:

1. `custom`
2. `native`
3. `user`
4. `channel`
5. `global`
6. `emoji`

Provider priority is only consulted when two candidates have the same scope. The default provider order is:

1. `custom`
2. `twitch-cheer`
3. `twitch`, `kick`, and `youtube`
4. `7tv`
5. `bttv`
6. `ffz`
7. `emoji`

Exact scope/provider ties keep the first candidate deterministically. Callers may override individual scope or provider priority values through `MergeCandidatesOptions`; the comparison remains scope-first and provider-second.

This means a sender-local user emote beats a channel or global emote, and a channel FFZ emote beats a global 7TV emote even though 7TV has higher provider priority.

### Exceptions before normal precedence

Two cases are handled before the ordinary scope/provider comparison:

- Platform-native message fragments remain authoritative over text-matched third-party emotes.
- A 7TV active emote carrying the relevant explicit override flag may replace a matching Twitch global/subscriber, BTTV, or FFZ candidate.

7TV's active zero-width flag is independent from provider override metadata. The base emote recommendation flag does not make an emote zero-width by itself.

## Renderer-facing asset selection

`Emote.images` carries structured variants when a provider exposes them. `Emote.altUrls` carries additional safe fallback URLs. Consumers can use:

```ts
import { emoteAssetCandidates, resolveEmoteAsset } from '@myrqyry/chatbus';

const asset = resolveEmoteAsset(emote, {
  animated: true,
  theme: 'dark',
  preferredFormats: ['avif', 'webp'],
  scale: 2,
  targetWidth: 64,
  targetHeight: 64,
});

const retryOrder = emoteAssetCandidates(emote, { scale: 2 });
```

With no preferences, the declared `emote.url` stays first. With preferences, candidates are ranked deterministically by:

1. animation match
2. theme match
3. preferred format order
4. nearest declared scale
5. intrinsic width/height suitability
6. original stable source order

Unknown animation/theme metadata ranks between an exact match and an explicit mismatch. Unknown scale does not block later dimension ranking. Duplicate URLs and unsafe URL schemes are removed before ranking.

Applications still own image loading, retry timing, decoding policy, caching, and visual layout. `Chatbus` only provides deterministic candidate order and metadata.

Chatbus owns its **shared emote-metadata cache**. When an older complete cached emote set has no scoped `candidates` (as in some pre-migration chat-core snapshots), `fetchChannelEmotesDetailed()` attempts a shared fresh load so consumers can safely recompute precedence during 7TV live updates. It accepts the replacement only when all providers succeed and the new candidate metadata accompanies that same snapshot. Failed or incomplete recovery returns the still-usable cached emotes, retaining `fromCache: true` and no invented scopes; later calls may retry. Aborting one consumer does not cancel the shared recovery for other consumers. A deliberate `bypassCache: true` still requests a fresh result directly.

## Derived URL metadata

When providers only expose URLs, `Chatbus` derives metadata conservatively:

- Twitch CDN tails such as `/default/dark/1.0`, `/static/light/2.0`, and `/animated/dark/3.0` contribute scale metadata.
- Filename variants such as `/1x.webp`, `/2x.webp`, and `/3x.avif` contribute scale metadata.
- Ordinary filename extensions can contribute format metadata.
- Numeric Twitch scale suffixes are extensionless; `/3.0` must not become an invalid `format: "0"`.

Unknown metadata remains unknown rather than being guessed.

## Twitch-specific behavior

### Catalog and EventSub native emotes

When Twitch supplies format/theme/scale metadata, normalized native emotes retain those known variants in `Emote.images`. `resolveTwitchEmoteAsset()` can choose a supported static/animated, light/dark, and 1x/2x/3x asset directly from the Twitch descriptor.

### IRC/tag-derived native emotes

IRC-style emote position tags identify the emote ID but do not disclose whether it is animated. Those emotes therefore use Twitch's `/default/{theme}/{scale}` CDN path for light/dark 1x–3x variants and intentionally leave animation metadata unset. This preserves animated emotes instead of incorrectly freezing them by forcing `/static/`.

A request such as `{ animated: true, theme: 'light', scale: 1 }` may still select the `/default/light/1.0` candidate because unknown animation state is preferable to an explicit static mismatch.

### Cheermotes

Normalized Twitch Cheermotes retain both dark and light collections and both animated and static variants when Twitch supplies them. Their image entries include theme, animation state, scale, and format metadata, allowing the generic resolver to honor renderer preferences without re-reading the raw Helix payload.

## Consumer guidance

Use `mergeCandidates()` for candidate collisions, then keep the resulting `EmoteSet` as the parser-facing map. Preserve the provider candidate list separately when live provider updates need precedence recomputation.

For image rendering, prefer `resolveEmoteAsset()` for one chosen source or `emoteAssetCandidates()` when the application wants a retry chain. Do not reimplement provider precedence or infer 7TV zero-width state from base metadata in application code.
