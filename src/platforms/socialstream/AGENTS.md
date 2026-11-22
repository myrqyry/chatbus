# Optional Social Stream Ninja adapter

- Never copy GPL implementation into Chatbus. Implement only the published interoperability protocol.
- Keep Node-only `ws` and session credentials outside the package main export and browser bundle.
- Source `type` is a platform identifier, not an event. Preserve known platforms; unknown -> custom + data.sourcePlatform.
- Pure normalization may not claim live transport; only actual received socket frames set origin live.
- HTML is data: use plain text and validated HTTPS image fragments. No raw HTML, executable scripts, or arbitrary image schemes.
- Preserve original currency units and explicit provider IDs; synthetic IDs are local only.
- Duplicate ID suppression is per SSN transport, not automatic cross-feed de-duplication.
- Real SSN integration needs the user to opt in to API control and chat publishing; localhost WebSocket tests are not proof of upstream availability.
