# AGENTS.md — `src/platforms/kick/`

Browser-native Kick Pusher transport and normalized social events.

- Resolved channels have two distinct Pusher feeds: `chatrooms.<chatroomId>.v2` for chatroom events and `channel.<channelId>` for channel-level subscription/gift events. Do not collapse them into one subscription.
- When `channelId` is known, readiness requires subscription-success acknowledgements for both feeds. Application frames may still be parsed while another requested feed is confirming, but must not falsely reset reconnect backoff.
- `ChannelSubscriptionEvent` and `LuckyUsersWhoGotGiftSubscriptionsEvent` normalize through Chatbus; consumers should not need a parallel Kick socket solely for those events.
- Honor Pusher's negotiated `activity_timeout`; keep reconnect/backoff state tied to a genuinely usable connection, not the WebSocket HTTP upgrade.
- Host/pin/poll/unban events remain structured `system` events unless a real cross-platform semantic contract exists. Do not relabel a Kick host as a Twitch-style raid just for convenience.
