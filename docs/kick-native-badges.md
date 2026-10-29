# Kick channel subscriber badge artwork

Chatbus emits Kick `badgeRefs` from live chat identity metadata. The realtime
payload currently provides role/type and subscriber count, not image URLs.

`createKickBadgeCatalog()` resolves channel subscriber references to actual
channel-owned artwork. It reads the public website's **undocumented**
`/api/v2/channels/<slug>` response, extracts `subscriber_badges`, validates
URLs on Kick's own badge image host, and picks the highest milestone not
exceeding the subscriber count. Unsupported roles (moderator, VIP, OG,
founder, gifting, etc.) do **not** acquire guessed images. Missing/invalid
counts remain unresolved. Chat messages can be shown before lookup completes;
consumers can apply a badge update on the catalog's `onReady` callback.

The channel catalog is independent of transports and rendering. The resolver
coalesces loads, caches results for 15 minutes, backs off failed fetches for
one minute, limits payload size and request duration, and rejects stale
channel results. Fetch/parse failure never prevents chat from connecting.

The endpoint is unofficial and can change. This is best-effort enrichment,
not evidence that all Kick badge kinds are supported. Tests use deterministic
fixtures; actual renderers should verify that artwork URLs load.
