# AGENTS.md — `src/platforms/twitch/`

EventSub WebSocket transport (`connectTwitchChat()`), not `tmi.js`. Needs runtime **user access token** with `user:read:chat`; never commit tokens.

## Subscriptions

- Default set: messages, deletes, notifications (subs/gifts/raids), settings, full clears, per-user clears. Duplicates suppressed by `message_id`. Server reconnect URLs = handoff (old socket lives until new welcome).
- Optional normalized subscriptions include channel metadata updates, stream online/offline, follows, Channel Points reward redemptions, channel bans/timeouts, and Hype Train. Never add them to default chat implicitly.
- `connection.subscriptions()` / `cheermotes()` / `onSubscriptionStateChange` expose session state; revocations drop from state.
- Cheermote enrichment from Helix needs no extra scope/secret; may load in background or via injected `cheermotes`/`getCheermotes`.
- `channel.ban` EventSub v1 specifically requires `channel:moderate`; do not replace it with the `moderator:read:banned_users` scope used by the separate `channel.moderate` capability.

## Capabilities (`planTwitchCapabilities()`)

Pure planner: records EventSub type/version, condition shape, scope alternatives, whether Chatbus normalizes it. Reward redemptions accept `channel:read:redemptions` OR `channel:manage:redemptions`; follow uses the moderator condition. Detailed `channel.moderate` remains descriptive. Never silently broaden permissions/runtime of a chat connection.

## Hype Train (opt-in)

`channel.hype_train.begin/progress/end` (EventSub v2, needs `channel:read:hype_train`; default chat needs only `user:read:chat`). All normalize to `type: 'hype-train'`; each notification stands alone — never assume `begin` precedes `progress`.

## Catalog

`fetchTwitchEmoteCatalog()` (global + broadcaster, no extra scope/secret). `resolveTwitchEmoteAsset()` picks supported static/animated × light/dark × scale with deterministic fallbacks. Normalized native emotes reuse this model via `Emote.images`.

Contracts: `docs/twitch-capabilities-and-replay.md`, `docs/chat-timeline-and-hype-train.md`.
