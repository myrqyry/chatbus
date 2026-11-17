# TikTok LIVE read-only transport — 2026-11-17

## Why this connector

TikTok LIVE chat is not available through a general official public
chat-read developer endpoint. The community TikTok-Live-Connector uses
TikTok's undocumented webcast events and Euler Stream signing. Read the
actual version's README and decoded protocol rather than assuming old
flat legacy payloads. References:
- https://ttlc.docs.isaackogan.com/
- https://www.npmjs.com/package/tiktok-live-connector/v/2.4.0
- https://www.eulerstream.com/docs/api/rate-limits

Registry metadata and packed license: tiktok-live-connector 2.4.0 is MIT
and pins tiktok-live-proto 0.2.3 (MIT). The newer 2.5.0 and proto 0.2.4
are AGPL. Pin 2.4.0 exactly in opted-in hosts and the Chatbus development
tests. The upstream library is not a mandatory runtime dependency.
No account, token, hosted service, or paid plan was created. Anonymous
signing was available during the live test; availability can change.
A host can set SIGN_API_KEY before constructing the first SDK instance;
the upstream SDK caches the signing client globally, so separate
credential configurations require host-owned drivers. Do not log keys
or expose a public passthrough relay.

## Integration

connectTikTokChat({channel, onEvent, onStateChange, onError, signal,
getEmotes}) returns a lifetime handle immediately. The same connector is
available via createChatBus({onEvent}).connect({platform:'tiktok',
options:{channel}}). Accept username, @username, or a validated TikTok
profile/LIVE URL. It loads the pinned library lazily only on Node, does not
process initial history, authenticate as a TikTok user, or send messages.
State connected means the SDK confirmed room readiness.

A 25-second initial deadline, caller abort, explicit closure and stream
end stop admission and release the SDK. If setup finishes late, the
result is disconnected again. SDK disconnect is asynchronous; pending
HTTP/setup cannot be forcibly cancelled through its public API. There is
no automatic retry/signing loop. Close a terminated bus handle before
explicitly reconnecting the same target. Host-specific driver creation is
available for independently configured clients and deterministic tests.

Supported normalized events: chat message (including the shared local
emote-code catalog), follow, finalized gifts as nonmonetary donation
events, stream-offline. Preserve exact string IDs, user displayId,
nickname, upstream timestamp (seconds or ms), room identity and raw
payload. When an upstream timestamp is absent, use the local receipt
time. Missing chat ID or sender drops that message instead of inventing
identity. Initial backlog is disabled, bounded event-ID dedupe is scoped
to the connection. Gifts carry gift ID, name, repeat count and known
diamondsPerGift; no fiat amount or currency is fabricated. Pending
streaks and unknown gift type are not admitted as completed gifts.
Native TikTok emote placement, badges, like/share events, subscriptions,
moderation, and account-authenticated operations are not implemented.
Gift/follow normalization is fixture-tested, not observed live.

## Consumer boundary

ChatPlatform and replay validation now recognize tiktok. The existing
generic relay protocol/status discovery recognizes the new platform;
a host still must explicitly allow it in resolveConnection. No
additional public endpoint or local listening service was added.
attachLocalKickRelay remains Kick-only. The other overlay applications
have not yet advanced their snapshots or exposed TikTok selection.
Veyax existing social/WebSocket contract suite passes, but its platform
allowlist currently rejects tiktok; do not send new signals there until
that consumer deliberately extends its contract. Existing v1 wire fields
are unchanged.

Browser bundle check with esbuild --bundle --platform=browser src/index.ts
succeeded with 51 source inputs and zero TikTok SDK dependency inputs.
The actual driver is a dev dependency here so the unit suite can run
the pinned v3 protobuf encoder/decoder. Runtime Node hosts install
tiktok-live-connector@2.4.0 explicitly.

## Verification

pnpm typecheck
pnpm test

253 tests across 42 files passed. New coverage includes exact string ID
preservation, validation, normalized custom fragments, nonmonetary
final gift handling, actual pinned v3 protobuf encoding/decoding,
readiness, duplicate IDs, stream end, cancellation, late creation and
setup, errors and relay target parsing. Existing Veyax contracts 14/14.

Actual public live room tv_asahi_news (no TikTok session/login or signing
API key supplied): first createChatBus read-only probe confirmed connected,
received six messages, then disconnected; no errors. Second probe used
the real generic relay, actual loopback WebSocket client and installed
SDK, received six real live messages, then awaited SDK disconnect and
confirmed isConnected=false. No messages or identifying viewer payloads
were retained in the receipts.

Reproduce explicitly against a public currently live room (Node 24, tsx
available, installed pinned dependency):

```sh
pnpm dlx tsx scripts/tiktok-live-smoke.mts tv_asahi_news
```

The smoke counts actual messages, checks source/provenance, and validates
the underlying disconnect after closing the relay client. A quiet or
offline room can fail the bounded observation; do not infer that all
TikTok streams are guaranteed accessible. No consumer UI changes,
deployment, credentials, or purchases are in this checkpoint.
