# TikTok LIVE

- Use the verified MIT tiktok-live-connector 2.4.0, which pins the MIT
  tiktok-live-proto 0.2.3. Newer 2.5.0/proto 0.2.4 releases are AGPL;
  reassess license, payload contract and live behavior before changing.
- Keep the dependency opt-in for the Node host. The main browser-safe
  entrypoint must not import this SDK statically. No login cookies,
  authenticated/mobile mode, message sending, or silent paid fallback.
- The official TikTok public developer API does not expose the public
  LIVE chat read path used here. This library uses unofficial webcast
  events and third-party signing. Respect service restrictions; manual
  retry only. Host may configure SIGN_API_KEY before first SDK instance.
- Read actual v3 decoded fields (common.msgId/roomId/createTime,
  user.id/displayId, content, gift.type, repeatEnd). Keep numeric IDs as
  strings. Never count pending streaks or turn diamond metadata into cash.
  Use Chatbus's shared fragment parser for known local codes; native
  TikTok emote index semantics are not qualified.
- Use connected state only after provider connect confirms room readiness.
  Skip initial history; stop admission and release on closed/error/end.
  Release late driver or connection even after the deadline. The SDK
  cannot guarantee immediate cancellation of pending HTTP/setup.
- Generic relay support does not opt TikTok into any existing host.
  Existing Kick-only helper, consumer snapshots and hosted endpoints are
  unchanged. Veyax must explicitly accept the new platform before routing.
- Reproduce with scripts/tiktok-live-smoke.mts against a public live room.
  Report counts and safe states, not private credentials or raw chat.
