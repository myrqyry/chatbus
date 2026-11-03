# Chatbus relay boundary

The relay is the optional cross-runtime wire adapter around Chatbus provider transports.

- `./relay` is browser-safe: protocol types plus `connectChatbusRelay()` only. Do not import Node APIs or provider credentials here.
- `./server` is Node-only and mounts a same-origin WebSocket upgrade onto an existing HTTP server. Keep this export isolated so ordinary browser consumers of `@myrqyry/chatbus` do not pull `ws`/Node code.
- Browser commands contain only `{platform,target}`. The host resolves that request to a full `ChatBusConnectionSpec`; OAuth tokens, API keys and provider-specific options stay server-side.
- One WebSocket currently owns one Chatbus connection. Preserve that simple lifecycle until a demonstrated consumer needs multiplexing.
- Reject cross-origin browser upgrades. Keep payload bounds small and never accept arbitrary executable/config objects over the wire.
- Relay normalized `ChatEvent` objects and connection state without re-parsing provider payloads. Chatbus remains the provider normalization authority.
