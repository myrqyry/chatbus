# Chatbus social signal handoff (v1)

Chatbus remains a framework-neutral event feed for Sketchy Chat, Noita Chat,
Veyax, and other applications. Its `ChatEvent` carries source-specific data;
a `SocialSignalV1` is a small **JSON-only, read-only projection** for social
perception consumers that run in different processes or languages.

```ts
import { createChatBus, toSocialSignal } from '@myrqyry/chatbus';

// In a consumer that has explicitly enabled a social-sense destination:
const bus = createChatBus({
  onEvent(event) {
    const signal = toSocialSignal(event, { receivedAtMs: Date.now() });
    forwardSocialSignal(signal); // application-owned transport
  },
});
```

This projection does not establish a WebSocket or send telemetry itself.
Applications own connection policy, authentication, backpressure, storage,
replay, and destination routing.

## Contract

- `schemaVersion: 1`, `producer: "chatbus"`.
- `source`: original `platform`, optional channel and connection identities,
  upstream aggregator and `origin` (`live`, `replay`, `test`).
- `event`: type, optional **real** event ID, upstream/normalized event
  timestamp (`occurredAtMs`), separate local projection/receipt wall time
  (`receivedAtMs`).
- `actor`: platform-scoped original account; not a cross-service person ID.
- `message`: text, message ID, parent and thread IDs when present.
- `upstreamBatchId`: upstream correlation only, not proof of duplicate content.
- `measurements`: allowlisted amount/currency (unaltered strings), bits/count
  (finite nonnegative numbers). No inferred money units or sentiment.
- `raw` is **never forwarded**; it remains on the original `ChatEvent`.

Social consumers must not infer identity equality, urgency, threats, intimacy,
truthfulness, or action authorization from this projection alone.
Platform messages and upstream event sources must remain independently attributable.

Current coverage: pure TS projection with deterministic unit tests. Live
Chatbus sources are independent of this export, so existing overlay consumers
continue using `ChatEvent` unchanged. A live Streamlabs connection requires
an account token; it is not implied by a passing local wire-protocol test.

## Veyax handoff

Veyax's optional `SOCIAL_SIGNAL` Genesis WebSocket action accepts this
object under `params.signal`. The server requires its existing WebSocket
authentication and `VEYAX_SOCIAL_SENSE_ENABLED=1`, and responds with a
`SOCIAL_SIGNAL_RECEIPT` (observed, duplicate, disabled, rejected).

A server receipt means Sena accepted structured evidence; it does **not**
mean Veya understood a message, scheduled attention based on social salience,
remembered it, spoke, or took an action. See Veyax `docs/SENAX_SOCIAL_FEED.md`.
