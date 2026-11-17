# Official Kick webhook intake — local checkpoint 2026-11-17

The direct web-client guest socket used by Noita returned HTTP 403 after
successful HTTP negotiation. The supported public event API is a separate
path; do not treat a relay or an OAuth token as a way to bypass that refusal.

References checked with Context7 and the official Kick developer sources:

- https://github.com/KickEngineering/KickDevDocs/blob/main/events/webhook-security.md
- https://github.com/KickEngineering/KickDevDocs/blob/main/events/event-types.md
- https://github.com/KickEngineering/KickDevDocs/blob/main/events/subscribe-to-events.md

The actual unauthenticated GET https://api.kick.com/public/v1/public-key
returned JSON containing data.public_key and message, despite the bare-PEM
example in the security documentation. The implemented key fetcher expects
the observed JSON response and validates the RSA key. No credentials used.

## Implemented boundary

The isolated Node-only @myrqyry/chatbus/server entry exports
fetchKickWebhookPublicKey and verifyKickChatWebhook. No Node crypto import
is added to the browser entry. The verifier takes the exact original bytes
(not reserialized JSON), Kick headers, a trusted public key, and the
host-owned expected subscription ID and broadcaster user ID. It checks
RSA PKCS#1 v1.5/SHA-256 over message ID + "." + timestamp + "." + raw bytes
before parsing JSON. It checks the expected subscription, chat.message.sent
version 1, required payload types, and broadcaster identity.

The output includes the verified delivery ID, delivery timestamp and
normalized ChatEvent. Reuses the current native marker parser and message
fragment parser, preserves user color/badge refs, message IDs and reply
metadata. Official broadcaster user IDs are not asserted to equal internal
web-client channel/chatroom IDs. Supports identified senders with valid
positive numeric IDs in chat.message.sent v1; other event types and
anonymous/unsupported sender shapes are deliberately not qualified.

## Host responsibilities and integration requirements

- Register the app and webhook using Kick's public API and the appropriate
  authorization; existing Chatbus OAuth utilities remain the token owner
  primitives. Do not expose app credentials to browsers.
- Bind allowed subscription IDs and broadcaster IDs using host-owned
  configuration. Type, version, and subscription headers are not included
  in Kick's documented signed bytes.
- Limit the request stream before allocating the body. The helper's 256 KiB
  limit is only defense in depth. Cache and refresh Kick's public key;
  retry verification with a legitimately refreshed key when appropriate.
- The verifier alone is stateless. The optional receiver below checks
  freshness and requires an atomic durable recording callback. A host
  must choose a retention/freshness policy compatible with Kick retries.
- Authenticate and authorize each relay client at the host boundary.
  Receiver target allowlisting and the existing same-origin upgrade check
  do not replace session authorization. Public HTTPS callback routing,
  storage and client authentication still need a production host.

Noita remains on its previous pinned Chatbus revision. No attempt to
subscribe to a live channel, change account settings or provision hosting.
This is not live delivery, a 403 fix, or a complete official Kick transport.

## Verification

pnpm typecheck
pnpm exec vitest run tests/kickWebhook.test.ts
pnpm test

Four focused tests use generated real RSA keys and signed original bytes
(not mocked crypto), validate the observed public-key response shape, test
native-emote/reply/user normalization, and reject modified bytes/timestamps,
missing signatures, wrong subscriptions/broadcasters/versions and invalid
signed payloads. Provider HTTP is fixture-controlled except for the
separate live public-key shape check.


## Local webhook-to-relay receiver — next checkpoint

`createKickWebhookReceiver`, exported from the same Node-only server entry,
takes host-owned subscription/broadcaster/target mappings, a trusted public
key supplier, and a required asynchronous atomic durable recordDelivery
callback. The callback persists verified deliveries and returns true only
for a newly inserted ID; duplicates return false. No in-memory dedupe
is substituted for durable storage. The receiver checks a configurable
timestamp window (local defaults: 5 minutes old, 30 seconds future skew),
limits streaming bodies to 256 KiB before key lookup and parsing, and
dispatches only after the recording callback succeeds.

The existing attachChatbusRelayServer connector seam can route an authorized
Kick target to receiver.connect(target, callbacks). All non-webhook
connections continue to use their existing host-owned route. The receiver
does not alter the wire protocol. Its connected state means a local
listener was attached to a configured subscription, not confirmation of a
live upstream registration or Kick delivery. A host must check the actual
subscription state independently.

Status: 204 for accepted or duplicate deliveries; 401 for invalid signatures,
unknown/mismatched registration or freshness failure; 413 for excessive
body size; 503 for key/storage failure or closed receiver. Host body/time
limits and authentication are still required. Storage must retain delivery
IDs for the full accepted replay window, including restarts. The local
test uses a temporary SQLite journal with a unique primary key and actual
persisted event JSON; no production storage schema or retention policy
was imposed. A committed delivery followed by a process crash or listener
failure may not reach clients: this is deduplicated best-effort live fanout,
not exactly-once delivery or a durable outbox/ack protocol. Callback
consumers are trusted server code. No key caching, subscription renewal,
rate limiter, public route, or credentials were configured.

Verification:
```sh
pnpm exec vitest run tests/kickWebhookRelay.test.ts
pnpm typecheck
pnpm test
```

Four focused cases pass. With generated RSA keys, real HTTP streaming
requests and actual loopback WebSocket relay/client sessions, two clients
for alpha received one normalized native-emote event each from concurrent
duplicate requests, while beta received only its own event. SQLite was
closed/reopened and the receiver recreated; retransmission remained
suppressed. This tests persistent storage reopening, not an OS crash.
Tampering, mismatched broadcaster, unknown registration, timestamp limits,
oversized and chunked streams, unavailable storage, faulty client callbacks
and shutdown during durable recording also passed. Full suite: 249 tests
across 42 files, TypeScript passed. No extra dependencies (SQLite used
only in Node 24 integration tests).

Existing infrastructure inspection: Sketchy has a loopback Vite dev/preview
relay, not a public webhook host; its Vercel config is static output.
Noita has its local blocked migration (87f4722), and chatbus-bot is a local
CLI consumer. No consumer changed or live subscriptions registered. Next
acceptance step is to identify an authorized public HTTPS host and register
the actual broadcaster subscription; qualify real Kick delivery through
that host and Noita, including authorization, durable storage, and social
events beyond chat.message.sent. Do not assume a Vercel rewrite is a
persistent WebSocket host.
