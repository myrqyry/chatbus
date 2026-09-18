# AGENTS.md — chatbus (`@myrqyry/chatbus`)

Framework-neutral livestream chat substrate (emotes, fragments, normalized events, connection lifecycle, timeline, replay). Apps own rendering.

- Single package, single entry: `src/index.ts` (also `main`/`types`/`exports["."]`). No workspaces.
- `src/`: `emotes/`, `identity/`, `messages/`, `network/`, `platforms/kick/`, `platforms/twitch/`, `platforms/youtube/`, `seventv/`, `testing/`, `types/`, `bus.ts`, `timeline.ts`. `tests/`: 23 Vitest files, no vitest config.
- Contracts live in `docs/`: `emote-precedence-and-assets.md`, `seventv-personal-entitlements.md`, `chat-timeline-and-hype-train.md`, `twitch-capabilities-and-replay.md`, `youtube-live-chat.md`. Trust them + code over `README` examples.

## Commands (repo root)

```bash
pnpm typecheck   # tsc --noEmit, strict, ES2022+DOM, includes src+tests
pnpm test        # vitest run
```

Order: `typecheck` → `test`. CI (`verify.yml`): Node 24, `pnpm install --no-frozen-lockfile` (no lockfile committed), then same two commands. No lint/format/build scripts.

## Consumption gotcha

Noita/Sketchy overlays pin Git commits of this repo. Advance their pins deliberately only after a verified change lands here.

## Nested notes

- `src/emotes/AGENTS.md` — precedence, assets, loader
- `src/platforms/kick/AGENTS.md` — dual Pusher feeds, readiness, normalization
- `src/platforms/twitch/AGENTS.md` — EventSub, capabilities, Hype Train
- `src/platforms/youtube/AGENTS.md` — YouTube polling, mutable-event dedupe
- `src/seventv/AGENTS.md` — live updates, entitlements
