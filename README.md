# Chatbus

![Chatbus — a chat bus with cat-ear accents and message windows](assets/chatbus.png)

`@myrqyry/chatbus` is a framework-neutral livestream social substrate shared by
the Noita and Sketchy overlays and suitable for desktop/agent consumers. It owns
Twitch, Kick, and YouTube Live transports; native and third-party emote discovery;
message fragments; identity metadata; normalized social events; platform
connection lifecycle; live provider and entitlement state; capability planning;
deterministic test/replay utilities; and bounded chat timeline state while
applications keep their own rendering and social-cognition models.

## Multi-platform connection manager

Individual connectors remain usable directly, but `createChatBus()` provides a
thin lifecycle layer for applications that need multiple simultaneous platforms.
It owns connection identity and aggregate state without hiding platform-specific
configuration or broadening permissions.

```ts
import { createChatBus } from '@myrqyry/chatbus';

const bus = createChatBus({
  onEvent: handleSocialEvent,
  onConnectionStateChange: (connection) => {
    console.log(connection.id, connection.state);
  },
});

await bus.connect({
  id: 'twitch-main',
  platform: 'twitch',
  options: { channel: 'ExampleChannel', accessToken: twitchToken },
});

await bus.connect({
  id: 'youtube-main',
  platform: 'youtube',
  options: { videoId: youtubeVideoId, apiKey: youtubeApiKey },
});

// Later: closes every managed connection.
bus.close();
```

Duplicate IDs are rejected rather than silently replacing a live connection.
Transport-specific connectors still own their own reconnect behavior.

## Emote loader

Use the convenience API when the application only needs the merged emote set:

```ts
import { fetchChannelEmotes } from '@myrqyry/chatbus';

const emotes = await fetchChannelEmotes('ExampleChannel');
```

Use the detailed API when the application needs provider health, cache state, or
the provider candidates needed to recompute precedence after a live update:

```ts
import { fetchChannelEmotesDetailed } from '@myrqyry/chatbus';

const result = await fetchChannelEmotesDetailed('ExampleChannel', {
  signal: connectionAbortController.signal,
});

if (!result.complete) {
  // Keep the application's last-known-good set during refresh.
}
```

Channel names are normalized with `trim().toLowerCase()` for cache and
in-flight request identity. A consumer abort only rejects that consumer's
promise; it does not cancel a request shared with other consumers.

A missing optional provider account is treated as an empty successful channel
result. Actual provider/network failures set `complete: false`. Degraded
results are returned to the current caller but are not cached, so a later
refresh can retry the failed provider instead of replaying the degraded result
for the full cache lifetime.

## Emote asset selection and fallbacks

`Emote.images` and `altUrls` retain provider variants instead of forcing every
consumer onto one hard-coded URL. `resolveEmoteAsset()` chooses one asset for a
renderer, while `emoteAssetCandidates()` returns the same deterministic order
plus safe fallbacks for retry-on-error behavior.

```ts
import { emoteAssetCandidates, resolveEmoteAsset } from '@myrqyry/chatbus';

const primary = resolveEmoteAsset(emote, {
  animated: true,
  theme: 'dark',
  preferredFormats: ['avif', 'webp'],
  targetWidth: 64,
  targetHeight: 64,
});

const fallbacks = emoteAssetCandidates(emote, { scale: 2 });
```

Without preferences, the provider's declared `emote.url` remains first. With
preferences, animation/theme/format are matched first, then scale and intrinsic
dimensions; stable source order breaks exact ties. Duplicate and unsafe URLs are
removed. Applications still own image loading/retry timing and presentation.

Twitch catalog/EventSub assets keep Twitch's known animation, theme, and scale
metadata. Tag-derived native Twitch emotes use `/default/{theme}/{scale}` because
IRC-style position tags do not disclose whether an emote is animated; their
animation state intentionally remains unknown rather than being forced static.
Cheermotes retain both light/dark and animated/static variants.

See [Emote precedence and asset resolution](docs/emote-precedence-and-assets.md)
for the full collision and asset-ranking contracts.

## Live 7TV updates

`connectSevenTvLive` keeps a channel's 7TV state current without polling. It
uses the 7TV V3 EventAPI heartbeat/session protocol, reconnects with backoff,
re-subscribes deterministically after each fresh HELLO, and applies
`emote_set.update` add/rename/remove changes incrementally.

```ts
import {
  connectSevenTvLive,
  fetchChannelEmotesDetailed,
  mergeCandidates,
  replaceSevenTvChannelCandidates,
} from '@myrqyry/chatbus';

const initial = await fetchChannelEmotesDetailed('ExampleChannel');
let candidates = initial.candidates ?? [];
let emotes = initial.emotes;

const live7tv = await connectSevenTvLive({
  platform: 'twitch',
  platformUserId: twitchUserId,
  cacheChannelName: 'ExampleChannel',
  onEmoteSetChange: (_sevenTvEmotes, info) => {
    candidates = replaceSevenTvChannelCandidates(candidates, info.candidates);
    emotes = mergeCandidates(candidates);
  },
});

// Later:
live7tv.close();
```

The live connection accepts Twitch or Kick platform user IDs, tracks active
emote-set reassignment through `user.update`, invalidates cached 7TV cosmetics
when relevant events arrive, and replays desired subscriptions after each fresh
HELLO rather than pretending EventAPI session resume is supported.

7TV has two different zero-width signals. Only the active-emote flag in the
current emote set means that the emote is actually configured as zero-width.
The base emote metadata's zero-width flag is only a recommendation and is not
used to force overlay behavior. Provider content metadata also preserves 7TV's
sexual, epilepsy, edgy, Twitch-disallowed, and listed flags without conflating
those flags with rendering behavior.

### Personal 7TV emotes and entitlements

Personal 7TV emotes are sender-specific entitlements, not channel-wide emotes.
`connectSevenTvLive()` tracks `entitlement.create`, `entitlement.delete`, and
`entitlement.reset` dispatches and keeps personal `EMOTE_SET` grants keyed by
platform user identity.

Wire the per-user map into Twitch normalization with `getUserEmotes`:

```ts
const sevenTv = await connectSevenTvLive({
  platform: 'twitch',
  platformUserId: broadcasterId,
});

const twitch = await connectTwitchChat({
  channel: 'ExampleChannel',
  accessToken: twitchUserAccessToken,
  getEmotes: () => channelEmotes,
  getUserEmotes: (userId) => sevenTv.personalEmotes(userId),
  onEvent: renderChatEvent,
});
```

Sender-local emotes win over shared third-party channel/global text matches,
while Twitch fragments explicitly marked as native stay authoritative. The live
7TV connection exposes `entitlements(userId?)`, `personalCandidates(userId)`,
and `personalEmotes(userId)`; applications that already own EventAPI delivery
can use `SevenTvEntitlementStore` directly instead.

7TV active-emote provider override flags are preserved for Twitch global,
Twitch subscriber/channel, BetterTTV, and FrankerFaceZ collisions. Explicit
7TV override flags are applied before the normal scope-first/provider-within-scope
comparison, while the active zero-width flag remains independent from all
override metadata.

See [7TV personal entitlements](docs/seventv-personal-entitlements.md) for the
state model, reconciliation behavior, and flag mapping.

## Twitch EventSub chat

`connectTwitchChat()` uses Twitch's current EventSub WebSocket transport rather
than `tmi.js`. Supply a **user access token** with `user:read:chat` at runtime;
do not commit the token to an application bundle or repository.

```ts
import { connectTwitchChat } from '@myrqyry/chatbus';

const connection = await connectTwitchChat({
  channel: 'ExampleChannel',
  accessToken: twitchUserAccessToken,
  clientId: twitchClientId,
  userId: twitchUserId,
  onEvent: renderChatEvent,
  onStateChange: (state) => {
    console.log('twitch chat:', state);
  },
});

connection.close();
```

The default subscription set covers chat messages, message deletion, chat
notifications (subs/gifts/raids/etc.), chat settings, full chat clears, and
per-user message clears. EventSub duplicate deliveries are suppressed by
`message_id`. Server-directed reconnect URLs are handled as handoffs so the old
socket stays alive until Twitch welcomes the replacement connection.

### Rich Twitch message context

Normalized Twitch messages retain parent/thread reply context, Shared Chat
source provenance, badges, native emotes, mentions, Cheermotes, renderer-neutral
GIF/media fragments, and useful traits such as highlighted, first-message,
emote-only, and custom reward state.

Cheermotes can be enriched from Helix without a new OAuth scope or client
secret. `connectTwitchChat()` may load them in the background, or consumers can
inject their own `cheermotes` / `getCheermotes` cache. The connection also
retains the EventSub subscription records created for its current session:

```ts
console.log(connection.subscriptions());
console.log(connection.cheermotes());
```

Revocations remove the affected subscription from that state and can be
observed through `onSubscriptionStateChange`.

### Twitch native emote catalog and assets

The validated Twitch auth returned by `connectTwitchChat()` can also load
Twitch's global and broadcaster-created emote catalogs. These Helix endpoints do
not require an additional OAuth scope and do not require a client secret.

```ts
import {
  fetchTwitchEmoteCatalog,
  resolveTwitchEmoteAsset,
} from '@myrqyry/chatbus';

const catalog = await fetchTwitchEmoteCatalog(
  connection.auth,
  connection.channel.id,
);

const emote = catalog.emotes.Kappa;
const animatedDark2x = resolveTwitchEmoteAsset(
  catalog.entries.find((entry) => entry.name === emote.code)!,
  { animated: true, theme: 'dark', scale: 2 },
);
```

Catalog entries retain the formats, themes, and scales Twitch says are actually
available. `resolveTwitchEmoteAsset()` chooses a supported static/animated,
light/dark, and size variant with deterministic fallbacks. Normalized EventSub
native emotes use the same asset model and expose all known variants in
`Emote.images` instead of hard-coding presentation choices into the parser.

### Twitch capability planning

`planTwitchCapabilities()` is a pure permission/subscription planner. It records
EventSub type/version, condition shape, OAuth scope alternatives, and whether
`Chatbus` currently normalizes that subscription.

```ts
import { planTwitchCapabilities } from '@myrqyry/chatbus';

const plan = planTwitchCapabilities(
  ['chat', 'followers', 'moderation'],
  {
    broadcasterUserId: channelId,
    userId: connection.auth.userId,
    scopes: connection.auth.scopes,
  },
);

for (const capability of plan.capabilities) {
  console.log(capability.id, capability.ready, capability.partial);
}
console.log(plan.missingScopeRequirements);
console.log(plan.suggestedScopes);
```

In addition to normal chat and Hype Train events, Chatbus can now normalize
opt-in `channel.update`, `stream.online`, `stream.offline`, `channel.follow`,
custom Channel Points reward redemptions, and `channel.ban` events. The planner
keeps OAuth alternatives explicit; for example, reward redemptions accept either
`channel:read:redemptions` or `channel:manage:redemptions`. Detailed
`channel.moderate` planning remains descriptive until its wider action surface is
normalized. None of these optional capabilities is added to the default chat
subscription set.

### Opt-in Hype Train events

Hype Train begin/progress/end are supported through Twitch's official EventSub
v2 subscriptions. They are intentionally opt-in and require
`channel:read:hype_train`; default chat still only needs `user:read:chat`.

```ts
import {
  DEFAULT_TWITCH_CHAT_SUBSCRIPTIONS,
  connectTwitchChat,
} from '@myrqyry/chatbus';

const connection = await connectTwitchChat({
  channel: 'ExampleChannel',
  accessToken: tokenWithChatAndHypeTrainScopes,
  subscriptions: [
    ...DEFAULT_TWITCH_CHAT_SUBSCRIPTIONS,
    'channel.hype_train.begin',
    'channel.hype_train.progress',
    'channel.hype_train.end',
  ],
  onEvent: (event) => {
    if (event.type === 'hype-train') {
      console.log(event.data);
    }
  },
});
```

All three phases normalize to `type: 'hype-train'` with structured level,
progress, goal, contribution, timing, train type, and shared-train metadata when
Twitch supplies it. Each notification is independently meaningful; consumers
must not assume `begin` always arrives before `progress`.

## YouTube Live chat

`connectYouTubeChat()` provides a browser/Electron-friendly YouTube Live Chat
connector using the Data API's paginated live-chat feed. It accepts either a
YouTube API key or OAuth access token, honors the server-provided polling
interval, follows continuation tokens, reconnects with bounded backoff, and can
skip the initial history page for overlay-style consumers.

```ts
import { connectYouTubeChat } from '@myrqyry/chatbus';

const youtube = await connectYouTubeChat({
  videoId: 'VIDEO_ID',
  apiKey: youtubeApiKey,
  emitInitialHistory: false,
  onEvent: handleSocialEvent,
});

// A known liveChatId can be supplied directly instead of videoId.
youtube.close();
```

Normalized YouTube events include text messages, memberships and milestone
messages, gifted memberships, Super Chats, Super Stickers, Jewels gifts,
message deletions/tombstones, bans/timeouts, members-only room-state changes,
polls, and chat-end/offline state. Monetary events use the neutral `donation`
event type rather than being mislabeled as Twitch Bits. Mutable same-ID gift
combos and active poll updates include their changing state in deduplication so
updates are not discarded as duplicate deliveries.

See [YouTube Live chat](docs/youtube-live-chat.md) for transport and event
semantics.

## Test, record, and replay normalized events

The testing helpers make overlay bugs reproducible without imposing a storage
backend on consumers.

```ts
import {
  ChatEventRecorder,
  createTestMessageEvent,
  replayChatEvent,
  serializeChatEvents,
  deserializeChatEvents,
} from '@myrqyry/chatbus';

const recorder = new ChatEventRecorder({ limit: 200 });
recorder.record(realEvent);

const fixture = createTestMessageEvent({ text: 'hello overlay' });
const replayed = replayChatEvent(fixture, { timestamp: Date.now() });

const saved = serializeChatEvents(recorder.snapshot(), 2);
const restored = deserializeChatEvents(saved);
```

`origin` distinguishes `live`, `test`, and `replay` events. Deserialization
structurally validates the typed event/message/user/emote surface before
narrowing input to `ChatEvent`; provider-specific `data` and `raw` remain
intentionally application-defined.

## Deterministic chat timeline

`ChatTimeline` reduces normalized events into bounded visible-chat state. The
default limit is 100 entries, entries stay timestamp-sorted, and moderation
mutations mark existing message entries deleted without destroying the
historical record.

```ts
import { ChatTimeline } from '@myrqyry/chatbus';

const timeline = new ChatTimeline({ limit: 100 });

timeline.apply(event);
render(timeline.visibleEvents());

const bootstrap = timeline.snapshot({ includeDeleted: true });
// Later, after loading application-owned storage:
timeline.restore(bootstrap);
```

`message-delete`, timeout/ban events, full chat clears, and per-user clears are
scoped by platform/channel and applied to prior message entries. Pure
`reduceChatTimeline()` and `reduceChatEvents()` helpers are available for apps
that prefer reducer-style state ownership.

This composes directly with recorder/replay: captured events can be replayed
through the same reducer to reproduce the visible overlay state that existed
when a bug occurred.

## Kick chat

`connectKickChat()` provides a browser-native Kick transport without pulling
Node-oriented `ws` or Axios dependencies into the package. It normalizes Kick
messages, native emotes, replies, badges/roles, deletes, bans/timeouts,
subscriptions, and gifted subscriptions into the same normalized contracts
used by Twitch. Host/pin/poll/unban payloads remain structured `system` events
instead of being mislabeled.

The Pusher lifecycle honors the negotiated `activity_timeout`, waits for the
handshake before subscribing, and only resets reconnect backoff after the
connection becomes genuinely usable. When a resolved Kick channel ID is
available, the connector subscribes to both `chatrooms.<id>.v2` and
`channel.<channelId>` and waits for both acknowledgements before reporting
`connected`; this preserves channel-level subscription/gift events that are not
carried by the chatroom feed alone.

## Precedence

Provider adapters return scoped candidates. Normal precedence is lexicographic:
scope is resolved first (`custom > native > user > channel > global > emoji`),
then provider priority breaks ties inside that scope. This prevents a global
emote from replacing a sender-local or channel emote merely because its provider
has a higher provider score. Within an equal scope, the default provider
priority is `custom > twitch-cheer > twitch/kick/youtube > 7tv > bttv > ffz > emoji`.

Two explicit exceptions are handled before the normal scope/provider comparison:

1. Sender-local personal emotes are resolved before shared third-party text
   matches, while platform-native message fragments remain authoritative.
2. A 7TV active emote carrying the relevant provider override flag may replace
   the matching Twitch global/subscriber, BTTV, or FFZ candidate.

The final `EmoteSet` contains no internal scope metadata. Applications should
retain a non-empty last-known-good set when a refresh reports `complete: false`.
For the complete precedence table, override exceptions, and renderer-facing asset
selection rules, see [Emote precedence and asset resolution](docs/emote-precedence-and-assets.md).

## Development

Run these commands from the repository root:

```bash
pnpm typecheck
pnpm test
```

`Chatbus` lives in its own Git repository. The Noita and Sketchy overlays
consume pinned Git commits of this package, so application dependency pins must
be advanced deliberately after a verified Chatbus change lands.

## Next steps

Later shared work can cover the remaining detailed Twitch moderation action
surface, processed-asset caching, additional platform adapters, a separate
shared connection/relay companion, desktop OAuth/account lifecycle helpers, and
platform-specific write/send/reply APIs without forcing privileged concerns into
read-only overlay consumers.
