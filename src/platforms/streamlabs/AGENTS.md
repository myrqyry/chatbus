# Streamlabs optional adapter

- `normalize.ts` is pure; it owns event mapping and raw provenance.
- `connect.ts` implements the narrow WebSocket-only Engine.IO v3 +
  Socket.IO v2 **read-only** subset. It uses the standard WebSocket API without
  a legacy Socket.IO dependency. Keep it limited to the default namespace
  and the `event` listener, with explicit unsupported-packet handling.
- `@myrqyry/chatbus/streamlabs` is opt-in; do not import it from root `src/index.ts`.
- Keep `platform` (originating service) distinct from `data.source` (Streamlabs feed).
- A single envelope may contain several messages; dedupe per stable message ID.
- Unknown and alert-system events remain visible through distinct callbacks.
- No cross-source dedupe, currency conversions or inferred platform identity.
- Socket token stays in the host process and connection URL, never error strings/logs.
- Verify with deterministic frame/lifecycle tests, a local real Socket.IO v2
  server oracle, typecheck, full suite and audit.
- Real Streamlabs authentication requires a real token; don't claim a live pass
  from an unauthenticated or localhost test.
