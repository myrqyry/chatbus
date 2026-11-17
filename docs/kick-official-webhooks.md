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

## Host requirements, not implemented here

- Register the app and webhook using Kick's public API and the appropriate
  authorization; existing Chatbus OAuth utilities remain the token owner
  primitives. Do not expose app credentials to browsers.
- Bind allowed subscription IDs and broadcaster IDs using host-owned
  configuration. Type, version, and subscription headers are not included
  in Kick's documented signed bytes.
- Limit the request stream before allocating the body. The helper's 256 KiB
  limit is only defense in depth. Cache and refresh Kick's public key;
  retry verification with a legitimately refreshed key when appropriate.
- Enforce timestamp freshness and durably deduplicate delivery IDs before
  fanout (the helper is stateless and intentionally does not claim replay
  protection). A host must choose a policy compatible with Kick retries.
- Deliver normalized events to authorized clients using a supported
  transport. Existing Chatbus relay remains available but does not yet
  consume webhook deliveries. A public HTTPS callback and client fanout
  need a host design; no service, subscription or cost authorized here.

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
