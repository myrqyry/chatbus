# Social Stream Ninja input (optional, Node-only)

Chatbus can listen to the documented Social Stream Ninja (SSN) WebSocket feed
without including SSN's GPL-3.0 code. The adapter interoperates with the
published channel-4 event contract; it does not install, fork, or run SSN.

Import only from `@myrqyry/chatbus/social-stream`:

```ts
import {connectSocialStream} from '@myrqyry/chatbus/social-stream';
const feed = connectSocialStream({
  sessionId: process.env.SSN_SESSION!,
  onEvent: event => receiveChatbusEvent(event),
  onError: error => console.warn(error.message),
});
feed.close();
```

Enable **both** "Enable remote API control of extension" and **"Send chat
messages to API server"** in Social Stream Ninja's settings. Keep SSN and
the source chat pages running. A WebSocket handshake indicates connection to
the relay, not proof that the extension is sending chat.

The adapter uses `wss://io.socialstream.ninja/join/{session}/4`.
Only secure remote WebSockets or explicit loopback endpoints are allowed.
The session ID belongs in the server process, never in an OBS URL, public
configuration, logger, or browser storage. It never issues remote commands.
Transport retries with bounded backoff, closes on dispose, and deduplicates
stable upstream message IDs across reconnects. Messages with no stable ID
receive an explicitly synthetic, connection-local ID rather than incorrectly
assuming repeat suppression.

SSN's `type` is the *source service*, not a Chatbus event type; `event`
specifies supported activity such as follow, subscription and superchat.
Known services retain Chatbus's native platform value. Unknown services map
to `platform:'custom'` while preserving the exact source name in
`data.sourcePlatform`. Source identifiers are namespace-isolated from native
Chatbus connections. Donation display units are retained exactly; no
currency conversion is inferred. Original source timestamps/user IDs are
not fabricated.

Only allowlisted `https:` badge and embedded emote images become presentation
assets. Untrusted HTML is converted to text/structured emote fragments; no
upstream DOM or arbitrary code enters overlays. Image data and URLs that do
not meet policy are discarded. This is intentionally *not* a general-purpose
HTML renderer.

A separate native connector and this SSN feed can see the same message;
deduplication is within the SSN source, not across distinct transport
origins. For chat sources handled natively by Chatbus, prefer the native path
unless an SSN-specific capability is needed.

Sources:
- https://github.com/steveseguin/social_stream/blob/main/api.md
- https://github.com/steveseguin/social_stream/blob/main/docs/event-reference.html
- GPL-3.0 applies to SSN's implementation; this is an independently written
  protocol adapter using its documented messages.
