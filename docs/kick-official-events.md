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
