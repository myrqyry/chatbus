# AGENTS.md — `src/emotes/`

Scoped candidates → merged set. Precedence is lexicographic: scope first (`custom > native > user > channel > global > emoji`), then provider within scope (`custom > twitch-cheer > twitch/kick/youtube > 7tv > bttv > ffz > emoji`).

## Exceptions (before normal comparison)

1. Sender-local personal emotes beat shared third-party text matches; platform-native fragments stay authoritative.
2. 7TV active-emote override flag may replace matching Twitch global/subscriber, BTTV, or FFZ candidate. Active zero-width flag is independent of override metadata.

## Assets

- `Emote.images`/`altUrls` keep provider variants. `resolveEmoteAsset()` picks one; `emoteAssetCandidates()` returns same deterministic order + safe fallbacks. Without prefs, provider `emote.url` stays first. Strip duplicates/unsafe URLs.
- Twitch tag-derived native emotes use `/default/{theme}/{scale}`; animation stays unknown (IRC tags don't disclose it). Cheermotes keep light/dark × animated/static variants.
- Full table: `docs/emote-precedence-and-assets.md`.

## Loader (`loader.ts`)

- Channel key: `trim().toLowerCase()`. Consumer abort rejects only that caller, not shared in-flight request.
- Missing optional provider account = empty success. Real failures → `complete: false`, returned to caller but NOT cached. Apps keep last-known-good non-empty set on `complete: false`.
- Legacy complete cache with non-empty emotes but no `candidates` gets a shared metadata recovery attempt. Promote only a matching fully complete refreshed snapshot; on degraded/failed recovery keep the old cached snapshot and allow later retries. Do not invent candidate scopes.
