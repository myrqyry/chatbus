# Optional anonymous Twitch IRC receive-only connector

Chatbus provides a small optional Twitch IRC transport, separate from the authenticated connectTwitchChat() EventSub connector. It requires no OAuth credentials and emits normalized ChatEvent objects.

## Behavior

- connectTwitchIrcChat({channel, onEvent}) opens wss://irc-ws.chat.twitch.tv:443, requests Twitch tags/commands/membership, sends PASS SCHMOOPIIE and a justinfan##### nickname, and joins the requested channel. It never sends chat PRIVMSG.
- Anonymous access is **not documented as a Twitch-supported authentication method**; Twitch recommends EventSub. Treat this as an opt-in best-effort read-only fallback, not guaranteed future support.
- It only reports connected after receiving ROOMSTATE or 366 for the target channel, not merely on WebSocket open, welcome or PING. An unacknowledged join times out and reconnects with bounded exponential backoff.
- The IRC parser recognizes exact command tokens, unescapes Twitch tags, limits frame memory, scopes events to the target channel and handles WebSocket-fragmented/multiple IRC lines. It responds to PING and RECONNECT.
- PRIVMSG normalizes Twitch user identity, badges, roles, emotes with native offsets, third-party emotes through getEmotes, cheers, replies, and Shared Chat source provenance. USERNOTICE preserves subscription, gift, raid viewer counts, viewer milestone/announcement text. CLEARMSG, CLEARCHAT and ROOMSTATE produce moderation and room-state events.
- Pure parsers do not invent live origin or upstream IDs. The live connection sets origin:live and generates visibly local fallback message IDs if Twitch tags omit an ID. It never fabricates upstream user IDs.
- AbortSignal and close() retire sockets/timers and suppress late callbacks. No cross-browser fanout, OAuth handling, chat writing, or authenticated EventSub changes.

## Example

    import { connectTwitchIrcChat } from '@myrqyry/chatbus';
    const connection = connectTwitchIrcChat({
      channel: 'example',
      getEmotes: () => currentEmotes,
      onEvent: event => console.log(event),
      onStateChange: state => console.log(state),
      onError: error => console.warn(error),
    });
    connection.close();

## Evidence

The new tests/twitchIrc.test.ts exercises 12 deterministic parser, event and lifecycle cases (RED before implementation, GREEN afterward). An independent Node WebSocket read-only smoke against a public channel received numeric 001 welcome and target ROOMSTATE; it sent no chat messages. This does not establish entire renderer/browser parity or ongoing Twitch support.

Twitch IRC reference: https://dev.twitch.tv/docs/chat/irc/
Twitch forum on undocumented anonymous login: https://discuss.dev.twitch.com/t/can-i-use-wss-irc-ws-chat-twitch-tv-with-justifan/63732
ChatYX was reviewed as a behavioral reference only; no GPL-3.0-only source was copied.
