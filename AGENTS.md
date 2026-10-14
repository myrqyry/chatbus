# AGENTS.md — chatbus (`@myrqyry/chatbus`)

Framework-neutral livestream chat substrate (emotes, fragments, normalized events, connection lifecycle, timeline, replay). Apps own rendering.

- Single package. Main entry: `src/index.ts` (`main`/`types`/`exports["."]`). Optional isolated `exports["./streamlabs"]` for the native-WebSocket Engine.IO v3 adapter. No workspaces.
- `src/`: `emotes/`, `identity/`, `messages/`, `network/`, `platforms/kick/`, `platforms/twitch/`, `platforms/youtube/`, `platforms/streamlabs/`, `seventv/`, `testing/`, `types/`, `bus.ts`, `timeline.ts`. `tests/`: Vitest files, no vitest config.
- Contracts live in `docs/`: `emote-precedence-and-assets.md`, `seventv-personal-entitlements.md`, `chat-timeline-and-hype-train.md`, `twitch-capabilities-and-replay.md`, `youtube-live-chat.md`. Trust them + code over `README` examples.

## Commands (repo root)

```bash
pnpm typecheck   # tsc --noEmit, strict, ES2022+DOM, includes src+tests
pnpm test        # vitest run
```

Order: `typecheck` → `test`. CI (`verify.yml`): Node 24, `pnpm install --no-frozen-lockfile` (no lockfile committed), then same two commands. No lint/format/build scripts.

## Social evidence boundary

- `src/social/signal.ts` exports the versioned, JSON-safe
  `toSocialSignal(ChatEvent)` projection for optional consumers including
  Veyax Senax. Keep raw `ChatEvent` intact for Sketchy/Noita.
- Do not add platform transports, sentiment/intent classification,
  model calls, behavioral decisions, or cross-account identity merging to
  the social evidence projection. It retains upstream IDs, timestamps,
  message thread references and explicitly known measurements only.
- Mark `origin: 'live'` at authenticated source-transport boundaries;
  pure parsers/replay fixtures should never invent that classification.
- Before changing wire fields, run both Chatbus unit tests and Veyax's
  `apps/api/test_sena_social.py`/WebSocket contract suite.

## Consumption gotcha

Noita/Sketchy overlays pin Git commits of this repo. Advance their pins deliberately only after a verified change lands here.

## Nested notes

- `src/emotes/AGENTS.md` — precedence, assets, loader
- `src/platforms/kick/AGENTS.md` — dual Pusher feeds, readiness, normalization
- `src/platforms/twitch/AGENTS.md` — EventSub, capabilities, Hype Train
- `src/platforms/youtube/AGENTS.md` — YouTube polling, mutable-event dedupe
- `src/seventv/AGENTS.md` — live updates, entitlements
- `src/platforms/streamlabs/AGENTS.md` — opt-in read-only Socket.IO v2 wire transport, protocol regression cases
