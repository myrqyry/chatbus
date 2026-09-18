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
