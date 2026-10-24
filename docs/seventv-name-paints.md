# 7TV name-paint contract

Chatbus currently fetches 7TV cosmetics through the **live legacy v3 API**:

1. `GET https://7tv.io/v3/users/twitch/{twitchUserId}` to find the linked 7TV user's `style.paint_id` and optional `style.badge_id`.
2. `POST https://7tv.io/v3/gql`, querying `cosmetics(list: ...)` for matching paint/badge metadata.

The provider-neutral `NamePaint` carries the v3 legacy fields (`function`,
`angle`, `repeat`, `stops`, `imageUrl`, `shadows`), the optional
`gradients` array and text styling (`weight`, `variant`, `transform`,
`stroke`, `shadows`). **Do not strip the legacy fields when
`gradients` is empty.** 7TV's v3 paint catalog still supplies these fields.
Paint colors are **signed 32-bit ARGB integers**, not necessarily positive
numbers. Gradient `at` values are ratios, and can legitimately exceed 1
(e.g., 1.01 means a 101% stop). The renderer, not Chatbus, converts ARGB
to CSS and constrains remote URLs/styles.

Evidence sampled on October 23, 2026: the public v3 GraphQL cosmetics catalog
contained 1,047 paints (645 linear, 269 radial, 133 URL); its inspected
gradients arrays were empty. The "Candy Cane" paint ID
`01FQ8S87J8000BDD0YMN21KEXG` uses signed ARGB stops,
`repeat: true` and separate shadows. Unit-test fixtures preserve these
observed shapes; CI does not require live API availability.

## Independently versioned v4 paint adapter

Chatbus now also exposes fetchSevenTvPaintV4Detailed(twitchUserId, options),
backed by POST https://7tv.io/v4/gql. The v4 GraphQL query resolves the
Twitch-linked user, active selected paint and matching inventory paint.

Its PaintData.layers normalize into NamePaint.layers with typed variants:
solid (ARGB color), linear (angle/repeat/stops), radial (shape/repeat/stops),
and image (HTTPS URL). Each layer retains its own opacity and array order.
V4 RGBA hex colors are converted to numeric ARGB. No remote CSS is accepted.

V3 and v4 are distinct API adapters, not two consumer implementations.
V3 retains legacy function/stops metadata; v4 retains ordered layers.
Both share a renderer-neutral NamePaint contract.

Successful no-paint responses are cached for five minutes, while HTTP
failures, GraphQL errors and missing active inventory paint are reported
as failures and not negative-cached. Concurrent lookups coalesce.
Use clearSevenTvPaintV4Cache on cosmetic invalidation.

The current v4 GraphQL query was accepted by the live endpoint on
October 23, 2026. Its sampled public identity had no paint; layered fixtures
are validated in deterministic tests, not claimed as an observed live
painted-user response.

Sources: 7TV's v3 API Swagger (`SevenTV/API` archive), 7TV Extension
`useCosmetics.ts` / `createGradientFromPaint`, and the newer
`SevenTV/SevenTV` GraphQL schema.
