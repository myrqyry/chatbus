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

7TV also publishes a **newer v4 layer-based paint schema**, with
`PaintData.layers` and `PaintLayerType` variants. That is a **different
contract**, not silently equivalent to the v3 fields. Chatbus does not yet
fetch or map v4 layered paints. A future v4 ingestion path will require a
separate verified endpoint, user-identity mapping, and contract tests.

Sources: 7TV's v3 API Swagger (`SevenTV/API` archive), 7TV Extension
`useCosmetics.ts` / `createGradientFromPaint`, and the newer
`SevenTV/SevenTV` GraphQL schema.
