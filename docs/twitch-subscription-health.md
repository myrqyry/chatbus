# Twitch EventSub subscription reconciliation

`connectTwitchChat()` uses a Twitch **EventSub WebSocket** transport. A live WebSocket proves only transport liveness; it does **not** prove that every requested EventSub subscription still exists. Missing chat notifications, moderation or other events can otherwise stay silent indefinitely, especially in a quiet room.

## Contract

- After a normal WebSocket welcome, Chatbus subscribes to the exact requested EventSub types. A response with **zero confirmed subscriptions** is not accepted as a healthy connection; the socket is closed so the existing reconnect path can establish a new session.
- On an established connection, Chatbus checks Twitch's official `GET /helix/eventsub/subscriptions?status=enabled` endpoint every **five minutes** by default. It follows all pagination cursors before reaching conclusions. It only considers enabled subscriptions with the **current WebSocket session ID** and the requested broadcaster. Other sessions (or channels) do not count.
- When a requested type is missing, `onSubscriptionStateChange` reports `reason: 'degraded'`, and Chatbus attempts one `POST /helix/eventsub/subscriptions` repair for each missing type. It reports `reason: 'repaired'` only after Twitch returns an enabled subscription record for that exact type. Successfully verified subscriptions are left alone (no blind duplicate `POST` calls). Normal new-session welcomes report `'subscribed'`, revocation frames `'revoked'`.
- Failed, rate-limited, malformed, or incomplete GET responses report `onError`, **without** claiming missing subscriptions or modifying the last-known subscription records. Failed POST attempts likewise surface errors and never claim successful repair. The next audit retries, with no overlapping audits.
- Twitch's server-directed reconnect URLs **transfer** subscriptions; after a handoff Chatbus audits the newly welcomed session ID. A genuinely lost socket instead uses the existing reconnect-and-resubscribe path. Closing or aborting the connection cancels/ignores in-flight inspections and creation responses and clears its audit timer.
- Audits require a valid **user access token** for this connector, are bounded to one every five minutes by default and may consume Twitch API rate limit. These are transport/subscription-health checks, **not** a chat-volume watchdog: no messages in a quiet channel is normal. Twitch cannot replay messages lost while an actual WebSocket was disconnected.

## Configuration

```ts
const connection = await connectTwitchChat({
  channel: 'example',
  accessToken,
  subscriptionReconcileIntervalMs: 5 * 60_000, // optional, default
  onEvent,
  onError,
  onSubscriptionStateChange(change) {
    // change.reason: 'subscribed' | 'revoked' | 'degraded' | 'repaired'
    // change.subscriptions: Chatbus's most recently confirmed records
  },
});

// Setting subscriptionReconcileIntervalMs: 0 disables the periodic GET audit.
// A positive custom interval must be >= 1,000ms.
connection.close();
```

No Streamer.bot or external service is required. This improves the library's ability to recover missing Twitch EventSub capabilities, not its provider/platform coverage or OBS control.

Evidence and reference: [Twitch Handling WebSocket Events](https://dev.twitch.tv/docs/eventsub/handling-websocket-events), [Twitch Get EventSub Subscriptions](https://dev.twitch.tv/docs/api/reference#get-eventsub-subscriptions), and independent failure-case study in All-Chat [ADR-0032](https://github.com/caesarakalaeii/all-chat/blob/main/docs/adr/0032-source-liveness-heartbeat-and-overlay-self-heal.md).

Verification: `tests/twitchSubscriptionRepair.test.ts` tests missing subscriptions, revoked capabilities, API errors, pagination, session handoffs, abort/close safety, non-overlapping audits and incomplete API data using deterministic fake WebSockets/fetch. **No live Twitch account/stream test is implied by this test suite.**
