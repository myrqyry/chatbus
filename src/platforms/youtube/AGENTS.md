# AGENTS.md — `src/platforms/youtube/`

Browser/Electron-native YouTube Live Chat transport and normalization.

- `connectYouTubeChat()` accepts `videoId` or `liveChatId`, plus API key or OAuth access token.
- Poll via the official list feed, honor `pollingIntervalMillis`, and carry `nextPageToken` forward. Do not invent a faster cadence.
- `emitInitialHistory: false` skips only the initial page; keep its event IDs and continuation token so later pages do not replay history.
- Jewels `giftEvent` and poll resources are mutable under stable IDs. Deduplicate gifts by ID + combo count and polls by ID + poll state, not ID alone.
- Keep Super Chat/Super Sticker/Jewels monetary events as `donation`; do not conflate them with Twitch `cheer`.
- Preserve platform-specific details under structured `data`; do not force false cross-platform equivalence.
- Chatbus does not own YouTube OAuth UI, refresh-token persistence, or renderer behavior.

Contract: `docs/youtube-live-chat.md`.
