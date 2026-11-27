# Kick native badge artwork

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

## Image-backed badges from `badges_v2`

Kick realtime and recent-message sender identities expose `badges_v2` entries
with `name`, `badge_type`, `image_url`, `selected`, and `sort_order`. Chatbus
normalizes valid image-backed entries directly to `ChatUser.badges` without
fetching or hardcoding a global badge catalog. Optional cosmetics such as
Flyby, GoldenK, and GOAT require `selected:true`; a `level` badge with valid
level metadata is displayed even when `selected:false`, matching observed Kick
chat UI behavior where level symbols appear as inline SVGs.

`parseKickUserBadgesV2` only admits HTTPS artwork on
`ext.cdn.kick.com/chat/badges/`, checks the declared type, deduplicates entries,
and preserves source ordering. For optional cosmetics, `selected:false`
entries are **not** displayed: the upstream object can include badges the user
owns but has not selected. The `level` exception is intentionally narrow. Kick
provides a hosted level `image_url` alongside its inline browser SVG; the
rendered image may not be pixel-identical to that SVG.
The existing legacy `identity.badges` subscriber references remain independent
and are resolved against channel subscriber milestones as described above.

No background per-user lookup is necessary; images arrive with each message.
This applies to future badges using the same valid native payload shape.


## Runtime role SVG enrichment

The same `createKickBadgeCatalog()` now starts an independent best-effort role
artwork lookup when `loadChannel(channel, onReady)` runs. Chatbus discovers
current public Kick design-system asset URLs, extracts the static named
ModeratorBadge, VerifiedBadge, Gift1 and Gift25 SVG bodies, and validates an
inert SVG grammar. It never evaluates downloaded JavaScript. No graphics
are bundled or written to disk. The process-level lookup is coalesced and
bounded by bytes, time and concurrency; it backs off on failures.

The catalog resolves exact provider refs to normalized `Badge` records with
`svgBody` and `images: []`. A native image-backed badge wins when callers
merge the native badges first. No unknown gifting tier is inferred.
Subscriber and role results notify independently; stale channel completions
cannot change current results. The existing `health()` describes subscriber
catalog health, not proof of full role-art coverage.

Consumers should keep their immediate chat path nonblocking and call
`catalog.resolve(refs)` again when notified. Use the browser-safe
`@myrqyry/chatbus/kick-artwork` export, `kickRoleImageUrl(badge.svgBody)`,
to validate again and construct an isolated image URL. Never insert
the SVG body directly into HTML. Retain semantic fallbacks when no art
is available. Low-level transport APIs remain transport-only; applications
or relays opt into the shared catalog, rather than implementing a second
provider-specific lookup. The runtime discovery is undocumented and does
not establish redistribution rights to Kick's artwork.
