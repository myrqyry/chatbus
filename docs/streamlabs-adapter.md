# Streamlabs socket adapter

Optional `@myrqyry/chatbus/streamlabs` integration, based on the official
[Streamlabs Socket API](https://dev.streamlabs.com/docs/socket-api) and the
MIT-licensed [meenzen/Streamlabs.SocketClient](https://github.com/meenzen/Streamlabs.SocketClient)
event schemas and fixtures. This is an independent TypeScript implementation,
not a C# translation.

**No Socket.IO dependency needed.** The Streamlabs endpoint documents
Socket.IO v2 / Engine.IO v3. Current Socket.IO v4 clients cannot directly
speak to that server generation, so the adapter implements a narrow, read-only
WebSocket-only subset of those protocols using the host's standard WebSocket API.

Requires a modern browser/Electron renderer or Node.js 22+ with global
`WebSocket`. For other trusted runtimes, supply `webSocketFactory`.

```ts
import { connectStreamlabs } from '@myrqyry/chatbus/streamlabs';

const connection = connectStreamlabs({
  token: streamlabsSocketToken, // keep in a trusted local process
  onEvent: handleChatEvent,
  onAuxiliary: event => handleAlertSystemEvent(event),
  onUnknown: event => logUnexpectedStreamlabsType(event),
  onStateChange: state => console.log('streamlabs', state),
});

// Later:
connection.close();
```

## Transport contract

- Secure `wss://` by default; `ws://` is allowed only for loopback test servers.
  WebSocket handshake appends `EIO=3&transport=websocket&token=...` to
  `/socket.io/`. Token travels in the TLS-protected URL query because
  Streamlabs requires it; do not log, persist, or expose that URL.
- Read-only default Socket.IO namespace; listens to the `event` event only.
  No arbitrary Socket.IO client emits, polling, upgrade negotiation,
  namespaces, or binary attachment support. Those features are intentionally
  not part of this adapter.
- A connection reports `connected` only after the Engine.IO open packet
  and Socket.IO namespace acknowledgement. Heartbeats follow server-provided
  Engine.IO v3 `pingInterval` / `pingTimeout`, with bounded reconnect backoff.
- Duplicate Streamlabs event IDs are suppressed per connection; unknown-ID
  messages are delivered without fake deduplication certainty.

## Normalization and limitations

- This is an additional **event source**, not a new chat platform.
  Twitch-origin follows remain `platform: 'twitch'`; Streamlabs donations
  without a known original platform remain `platform: 'custom'`.
  Each normalized event retains `data.source: 'streamlabs'` and upstream IDs.
- Streamlabs batches envelopes, each of which may contain several independent
  `message` entries. Each gets its own ID and normalized event.
- Monetary values stay in their supplied units/strings; YouTube `superchat`
  values must not be assumed to be dollar decimal amounts.
- Streamlabs alert playback, Streamlabels, volume and credits events are sent
  **only** through `onAuxiliary`, not turned into social actions.
- Unknown/new events go to `onUnknown`, not a misleading generic chat event.
- Bounded per-connection dedupe handles repeat Streamlabs message IDs, but
  **does not** dedupe against Twitch EventSub or other platform transports:
  their IDs are not necessarily shared. Apps combining sources must choose
  one authoritative source per action or reconcile using trusted IDs.

## Validation boundary

- TypeScript typecheck and the repository's full deterministic suite.
- Real Socket.IO 2 server integration check (unmodified `socket.io@2.5.1`,
  installed temporarily outside the repository): native WebSocket reached
  `connected`, received an actual `event` payload, and remained connected
  beyond several server-configured Engine.IO heartbeat rounds.
- This checks **protocol compatibility with Socket.IO v2**, not Streamlabs
  account authentication or real Streamlabs events. No production token or
  live Streamlabs account test has been run.
