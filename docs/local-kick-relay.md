# Shared local Kick transport

Noita's original November 9 work migrated from overlay-owned Pusher
configuration to Chatbus. Overlay Kit already owns a server-side Chatbus
source, and Sketchy already prefers a local Chatbus relay. Preserve the
anonymous negotiated transport; Kick OAuth is optional and separate.
The experimental official webhook receiver was reverted, with its Git
history preserved. No public webhook, tunnel, registration or deployment
is part of this path.

Local host: attachLocalKickRelay({server, emitInitialHistory}). Mount its
handleStatus(req,res) ahead of static fallback, and close it with the
server. It checks local peer and Host for both status and WebSocket, plus
the existing same-origin upgrade check. It validates the Kick target and
allows no other provider. Hosts remain responsible for not exposing these
routes through a public reverse proxy. Browser discovery uses
getLocalChatbusRelayStatus(fetcher?, signal?), with a two-second abort
deadline, compatible protocol and an allowlisted platform list.
Connection readiness still comes from the upstream state callbacks.

Sketchy seeds up to 20 recent messages; Noita does not replay history as
particle emissions. Overlay Kit keeps its display-safe hub and mixer
rather than replacing its presentation protocol with raw Chatbus packets.
The provider implementation remains shared. All applications use exact
tracked source snapshots; update them from a clean upstream commit, not
by editing copies. No alternate connection or public service required.

Observed on Nov 17: direct Node Chatbus connected to a public Kick channel
and acknowledged subscriptions after 3.23 seconds, then disconnected at
the intentional 12-second cutoff; zero live messages arrived in that
window. The earlier browser 403 is a separate observation, not a global
provider failure. Do not claim live message parity from this receipt.
The local relay tests use actual loopback HTTP and WebSockets, checking
capability discovery, abort/timeout, history options and nonlocal
upgrade rejection. Full root verification and consumer receipts are
recorded with their respective commits.

## Final consumer verification

The exact source snapshot c3c65580e003a20e5ad91a29c580418e2a7e1360 was archived into all three consumers and compared byte-for-byte with their installed packages. Recent history is replay, not live. Real production-preview Chromium: Noita one live / zero replay; Sketchy seven live / 20 replay, both confirmed connected, zero direct browser provider sockets, page errors or CSP violations. Overlay Kit existing local HTTP/WebSocket hub: four live / 20 replay, 24 display messages and social signals. These are finite smoke receipts, not throughput measurements. All four repository test suites passed (245/513/407/527), all typechecks and consumer builds passed; Veyax social/WebSocket contracts 14/14. Sketchy full lint retains existing unrelated errors. No deployment, public webhook, credentials or extra hosting.
