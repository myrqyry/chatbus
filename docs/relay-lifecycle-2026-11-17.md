# Relay lifecycle and Kick integration — 2026-11-17

Noita's existing Kick migration is preserved at local commit 87f4722.
Local Chromium reached the negotiated Centrifugo endpoint after same-origin
HTTP negotiation, but the actual provider WebSocket handshake returned 403.
Do not mistake passing protocol fixtures for successful live chat.

Chatbus now owns the optional realtimeBaseUrl for global and channel
negotiation, authentication and scheduled token refresh. Default endpoints
and returned websocket selection are unchanged. Noita's pinned pnpm patch
can be retired after a verified upstream revision is available to consumers.
Noita owns only its host routing/configuration and rendering.

Five regression cases failed before these changes: alternate negotiation
base including token refresh, two browser cancellation cases, and two real
loopback WebSocket tests for disconnect during host resolution and delayed
provider handle delivery. All passed afterward. A closed relay session
does not start a provider after host resolution; a late provider handle
is closed on arrival. Browser cancellation rejects the pending open and
suppresses stale packets. Shutdown also terminates tracked client sockets.
This does not guarantee a pending host resolver or provider operation
that ignores cancellation will settle immediately.

Verification: pnpm typecheck; 16/16 focused tests; 241/241 full tests
across 40 files. No wire protocol or dependency changes. Actual Kick
authorization, live message delivery, Noita consumer snapshot update,
deployed transport and OBS rendering remain open. The later shared local relay work is recorded in local-kick-relay.md; the webhook experiment was reverted. No persistent relay provisioned.
