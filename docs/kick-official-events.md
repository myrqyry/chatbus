# Official Kick event intake

The server entry point exports createKickWebhookReceiver and fetchKickWebhookPublicKey.
The browser-safe entry point exports normalizeKickOfficialEvent and the ten documented v1 event names.
See the official KickDevDocs events/event-types.md and events/webhook-security.md.

The receiver checks the exact body bytes with RSA-SHA256 and the documented message ID/timestamp prefix; the host must supply a trusted public key and a subscription registry binding subscription ID to event type, version and broadcaster ID. It rejects old/future deliveries, malformed payloads, mismatched bindings and unknown versions. Bounded in-memory deduplication acknowledges completed deliveries only; in-flight and failed deliveries remain retryable. No durable deduplication across restart or deployment is claimed. Kick signs the body, message ID and timestamp, not every header; the registry must be maintained from trusted registration results and must not accept arbitrary caller input.

The adapter emits ordinary chat, follows, new/renewal subscriptions, gift subscriptions, reward redemption/status, Kick gifts, livestream state/metadata, and moderation evidence. Kick gift amounts are typed provider-specific units; they are never converted into cash or Twitch Bits. Pending reward notifications create redemptions; accepted/rejected notices are status updates (an accepted-only redemption cannot currently create an alert). Duration of a subscription is not necessarily cumulative tenure.

The public HTTPS receiver, subscription registration/reconciliation, hosted authentication/authorization, durable idempotency, delivery/transport arbitration and public-key cache/rotation policy are not deployed. The existing anonymous browser and Node transport remains independent and unchanged except gift count and message-deletion evidence. Do not enable webhooks until the ingress and ownership boundary is reviewed. Signed fixtures verify the receiver with a generated RSA key; they do not establish actual Kick delivery. The live public-key probe from the development machine failed; retry when wiring ingress.

## Contract audit follow-up

The current live public-key endpoint was verified from the workstation: HTTP
200, JSON with data.public_key, parsed successfully as RSA. The security
guide's Go example instead reads raw PEM. The loader now accepts both,
caps the response and validates the actual RSA key, with a five-second
request/body timeout. Host-managed caching/rotation remains an ingress concern.

The normalizer retains subscription expiry, original reward redemption time
and description separately from update delivery time, parent reply text and
identity, bounded provider emote positions (original marked-up content),
stream category/maturity details, and ban reason/moderator/creation time.
Moderation reason stays in the original event data, not the social signal.
Subscription duration is still not cumulative tenure.

The server entry point also exposes reconcileKickWebhookSubscriptions.
It takes an explicitly authorized app access token and desired event names
for an owner-selected broadcaster. It reads the existing webhook inventory,
creates only missing v1 events and reads back actual registrations; partial
success remains missing rather than falsely active. No deletion, automatic
timer or blind retry. The API ignores broadcaster_user_id on a user-token
POST, so hosts must supply an app access token, not a user access token.
The host must serialize reconciliation and maintain a trusted registry;
no public webhook, periodic scheduling, live subscription mutation or
transport arbitration is enabled. Current API contract confirmed against
https://api.kick.com/swagger/doc.yaml and KickDevDocs. Key retrieval is
live-verified; registration/reconciliation tests use fixtures.

## Subscription removal and signing key cache

Server hosts may explicitly call removeKickWebhookSubscriptions with an app
access token, broadcaster ID and selected subscription IDs. It inventories
first, intersects those IDs with the broadcaster's webhook registrations,
uses repeated id query parameters for DELETE, requires HTTP 204, then
reads back the inventory. Missing or foreign IDs are not deleted; remaining
IDs are reported rather than falsely marked removed. An inventory failure
prevents a write. Serialize this with creation/reconciliation in the host.
An explicit ID must belong to the caller's authorized app and broadcaster;
the host must enforce its own account/tenant authorization and ownership
policy. No automatic deletion, live calls, or UI disconnect wiring yet.

The server receiver accepts a shared createKickWebhookKeyCache instance.
Defaults: one-hour TTL and 30-second minimum refresh interval. Concurrent
loads coalesce, mismatched signatures can trigger a refresh and one
verification retry, and expired keys are not used when refresh fails.
A new key replaces the previous key, without a previous-key grace period.
Mismatches during cooldown may be rejected until refresh is allowed;
hosts should monitor rejection/refresh failures. The existing injected
getPublicKey path is preserved for explicitly managed keys.
Cache state is per process, in memory, with no background timer.
Use one cache for the host rather than constructing it per request.
Tests cover explicit scoped removal, readback, no-op, rotation, coalescing,
refresh throttling and expired-key failure using fixtures. No live
subscription mutation or public ingress is enabled.

## Durable delivery ledger

The optional server-only openKickSqliteDeliveryStore uses Node 24's built-in
SQLite (no external dependency). The caller provides an owner-private
directory and database file (0600). It persists delivery IDs, claim tokens,
lease deadlines and completion status only, not payloads, user data, or
credentials. Use one ledger for each app/receiver identity; the caller
owns lifecycle and closes it after draining active deliveries.

createKickWebhookReceiver accepts deliveryStore. Only authenticated,
normalized events can claim an ID. The store atomically claims across
database connections, reports completed IDs as duplicates, and rejects
in-flight/capacity-limited claims as retryable unavailable. Defaults:
60-second recovery lease and 20,000 retained records. Expired records are
pruned on claim; completion retention covers the accepted signed timestamp
window. SQLite transactions are short and synchronous, with a bounded
100ms lock timeout. This is a local persistent-host adapter, not a shared
serverless/multi-host store. The asynchronous store interface permits a
different implementation on a hosted ingress.

Delivery is at-least-once: after an acknowledged completion, duplicates
are suppressed across restarts. A process crash after a sink side effect
but before the durable completion commit can cause a retry, and a callback
running longer than its lease can be reclaimed by a different receiver.
Fencing protects the ledger from old claims, not arbitrary sink side
effects. Hosts must use bounded callbacks and idempotent sinks (or a
transactional inbox/outbox) for stronger guarantees. No public HTTP ingress
or live subscriptions are enabled by this change. Tests use real SQLite
files, close/reopen, separate database connections, signed fixtures, retry
and permissions checks.

## Isolated HTTP ingress

createKickWebhookIngress composes the server receiver, shared key cache,
durable delivery store, and host-owned subscription registry on a separate
127.0.0.1-only HTTP listener. Only POST /webhooks/kick is accepted; there
are no control-room, OAuth, browser, or subscription-management routes.
The host supplies authorized API-readback rows to
createKickSubscriptionRegistry; replaceBroadcaster atomically replaces only
one broadcaster's inventory, rejecting conflicting IDs. The registry is
in memory and must be reconstructed from trusted inventory after restart.
Never accept registry entries from a webhook request or browser caller.

The listener verifies the original bytes (no parsing, decompression, or
body reserialization before signature verification). It rejects duplicate
security/content headers, non-JSON or encoded content, bodies above 256 KiB,
and unexpected paths/methods. Bounds: 16 KiB headers, 10s absolute body-read
deadline, 15s HTTP request timeout, 128 connections, default 32 concurrent
deliveries (configurable to 128). Returns empty 204 for accepted or
acknowledged duplicate, 400 for invalid delivery, 413 for oversized body,
415 for unsupported content, 503 with Retry-After for retryable failure.
Shutdown stops admission and drains callbacks before the host closes its
ledger. Callbacks must be bounded; a stalled callback delays shutdown.

For deployment use a separately configured HTTPS reverse proxy routing
only the exact webhook path to this listener; preserve raw body bytes,
reject duplicate headers at the proxy, enforce connection/body limits,
and never route the local control room. TLS, host auth/tenant lifecycle,
persistent registry hydration, periodic reconciliation, cross-host
idempotency, and live transport ownership remain host responsibilities.
The public endpoint is not deployed or registered by this library.
Seven tests exercised real loopback HTTP, generated RSA signatures and
SQLite, including chunked oversize, callback failure/retry, duplicate
headers, registry isolation and drain behavior. This is not evidence of
actual Kick-originated delivery.

## Transport ownership

createKickTransportArbiter operates per host-verified binding of Kick
slug, official broadcaster user ID and native channel ID. These are
different identity namespaces. It rejects foreign events and rewrites
accepted official events to the native channel identity for consumers.
Native chat/moderation remains preferred while native transport is
connected, with official fallback while disconnected. Exact chat
message IDs are remembered for ten minutes (bounded at 10,000 entries).
No username, text or time similarity matching is used.

A host may explicitly assign subscription ownership to official delivery
only while BOTH new and renewal feeds are confirmed healthy; gift
ownership is independent. Revoking that coverage restores native fallback.
Official-only families remain available irrespective of native connection.
Registration alone is not proof of delivery health. The caller owns
coverage updates. Changes in ownership can still race for events without
a shared provider ID, and native-native duplicates without an ID are not
resolved by this arbiter. No live delivery is enabled by this change.
