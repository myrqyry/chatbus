# YouTube Live chat

`connectYouTubeChat()` is the browser/Electron-native YouTube transport. It uses
the YouTube Data API live-chat list feed, follows `nextPageToken`, and waits at
least the server-provided `pollingIntervalMillis` before the next request. A
consumer may provide either `videoId` (Chatbus resolves the active live chat) or
a known `liveChatId` directly.

## Authentication and lifecycle

Exactly one usable credential is required: an API key or OAuth access token.
OAuth is sent as a bearer header; an API key is supplied as the request key.
Chatbus does not own OAuth login, refresh-token storage, or desktop credential
persistence.

The connector reports `connecting`, `connected`, `reconnecting`, and
`disconnected` states. Transient request failures (including rate limiting) use
bounded exponential backoff. Terminal chat errors such as `liveChatEnded`,
`liveChatDisabled`, and `liveChatNotFound` stop instead of reconnecting forever;
`liveChatEnded` also emits a structured chat-ended event. `AbortSignal` and
`connection.close()` stop polling.

The first list response can contain recent history. `emitInitialHistory: false`
advances the continuation token and remembers those event identities without
emitting them, so later pages begin at the live edge without replaying the first
page.

## Normalized event semantics

YouTube source events map to shared `ChatEvent` semantics without pretending
platform-specific concepts are identical:

| YouTube source | Chatbus event |
| --- | --- |
| text message | `message` |
| new member / membership milestone | `subscription` |
| membership gifting / received gift | `gift-subscription` |
| Super Chat / Super Sticker / Jewels gift | `donation` |
| deletion / tombstone | `message-delete` |
| temporary ban | `user-timeout` |
| permanent ban | `user-ban` |
| members-only mode | `room-state` |
| poll | structured `system` (`kind: 'poll'`) |
| chat ended | structured `system` (`kind: 'chat-ended'`) |
| `offlineAt` list state | `stream-offline` |

`authorDetails` become YouTube `ChatUser` identity with stable channel ID when
available. Owner, moderator, member, and verified traits are retained as
YouTube badge references/roles.

## Mutable events and deduplication

Most live-chat resources are immutable and are deduplicated by message ID.
YouTube can reuse a Jewels gift event ID while increasing its combo count, so
gift deduplication includes `comboCount`. Poll state can also change under one
resource ID; its normalized poll payload participates in the dedupe key.
`activePollItem` is processed alongside ordinary page items.

This rule prevents network/page overlap from duplicating ordinary chat while
preserving meaningful updates to mutable social events.

## Optional public InnerTube reader (Node only)

`@myrqyry/chatbus/youtube-innertube` exports
`connectYouTubeInnertubeChat()`. This separate, read-only adapter uses
`youtube-chat-next@3.1.0` to read a public livestream by channel handle,
YouTube channel ID, or live video ID **without supplying credentials**.
It is intentionally not imported by the browser-safe main entry. The default
`createChatBus()` can accept an explicit `connectYouTubeInnertube` factory for
`{platform:'youtube', transport:'innertube'}` connections, or a Node consumer
can use `createNodeChatBus()` from the isolated subpath to supply the factory.
No automatic fallback silently changes the official transport.

The reader explicitly selects YouTube's **Live chat** (not filtered Top chat),
uses the upstream self-scheduling fetch loop and requested poll interval, and
normalizes incoming items to the same `ChatEvent` contract:

- Messages retain YouTube author channel IDs, owner/moderator/member/verified
  roles, timestamps, and ordered text and emoji runs. HTTPS image assets are
  emitted as native `emote` fragments with `provider: 'youtube'` or `emoji`.
- Super Chats and Super Stickers are `donation` events; even no-text paid
  stickers are preserved, including the formatted amount and sticker image.
- Message IDs are deduplicated in a bounded 2,000-ID window; callbacks stop
  after `close()` or an abort signal. Real received events have `origin: 'live'`.
- The upstream package exposes a smaller event vocabulary than the official
  API. It does **not** promise delete/moderation/poll/membership-event parity,
  OAuth features, chat sending, or stable official APIs.

Example:

```ts
import { connectYouTubeInnertubeChat } from '@myrqyry/chatbus/youtube-innertube';

const reader = await connectYouTubeInnertubeChat({
  handle: '@ExampleChannel',
  onEvent: (event) => console.log(event),
  onStateChange: (state) => console.log(state),
  onError: (error) => console.error(error),
});

// On shutdown:
reader.close();
```

Use this through a Node host or a relay for browser overlays. It relies on
reverse-engineered YouTube web endpoints; YouTube can change them, rate-limit
requests, or restrict automated access. Review YouTube's terms before deploying.
A successful unit test does not prove the live endpoint is currently working.
The official connector remains the recommended supported option.

The **official** API connector now also respects `Retry-After` on HTTP
429/503 responses (seconds or HTTP date), without shortening the existing
exponential backoff. Its server-advertised normal polling cadence is unchanged.
