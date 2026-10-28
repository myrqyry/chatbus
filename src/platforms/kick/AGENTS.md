# AGENTS.md — `src/platforms/kick/`

Negotiated Kick realtime transport and normalized social events.

- Do not pin a Kick realtime provider or app key. Resolve `web.kick.com/api/v1/realtime/connection` on every connection/reconnect and use the provider Kick returns.
- Current Kick web chat prefers Centrifugo. Mint the anonymous guest connection token from `/api/v1/realtime/auth/connection`, query the resolved channel's `/chat/connection` endpoint, answer `{}` pings with `{}`, refresh expiring tokens, and resubscribe after reconnect.
- For Centrifugo, subscribe the current web-client channel set: `channel_<channelId>`, `channel.<channelId>`, `chatroom_<chatroomId>`, `chatrooms.<chatroomId>`, and `chatrooms.<chatroomId>.v2`. Readiness requires all requested subscription acknowledgements.
- Pusher remains a negotiated fallback. When Kick returns it, use the returned app key/cluster; never restore the retired hard-coded key.
- `ChannelSubscriptionEvent` and `LuckyUsersWhoGotGiftSubscriptionsEvent` normalize through Chatbus; consumers should not need a parallel Kick socket solely for those events.
- Keep reconnect/backoff state tied to a genuinely usable connection, not merely a WebSocket HTTP upgrade.
- Host/pin/poll/unban events remain structured `system` events unless a real cross-platform semantic contract exists. Do not relabel a Kick host as a Twitch-style raid just for convenience.
