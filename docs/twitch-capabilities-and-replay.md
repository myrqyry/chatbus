# Twitch capabilities and event replay

`Chatbus` keeps Twitch authentication planning separate from connection side effects. The capability registry describes which EventSub subscriptions belong to a feature, which condition fields they need, and which OAuth scopes must be present before that subscription is ready.

```ts
import { planTwitchCapabilities } from '@myrqyry/chatbus';

const plan = planTwitchCapabilities(
  ['chat', 'followers', 'rewards', 'moderation'],
  {
    broadcasterUserId,
    userId,
    scopes: validatedTokenScopes,
  },
);

for (const capability of plan.capabilities) {
  console.log(capability.id, capability.ready, capability.partial);
}

for (const subscription of plan.subscriptions) {
  if (!subscription.ready) {
    console.log(subscription.type, subscription.missingScopeRequirements);
  }
}
```

Each `TwitchScopeRequirement` is an OR-group. Every group attached to a subscription must be satisfied, but any one scope inside a group is sufficient. This matters for capabilities such as Channel Points redemptions, where `channel:read:redemptions` and `channel:manage:redemptions` are alternatives, and for the larger moderation surface.

The planner is descriptive. A subscription being `ready` means the supplied token/scopes and IDs satisfy the known EventSub requirements; it does not automatically mean `Chatbus` normalizes that event. `handledByChatbus` distinguishes runtime-normalized subscriptions from definitions that are present for future optional packs. Chatbus currently normalizes default chat, Hype Train, channel updates, stream online/offline, follows, custom reward redemptions, and `channel.ban`; detailed `channel.moderate` remains planner-only.

The registry intentionally does not broaden the default `connectTwitchChat()` subscription set. Normal chat keeps its small `user:read:chat` contract; optional requested subscriptions add only their documented scope requirements. `connectTwitchChat()` remains a chat-oriented authenticated connector, so token validation still requires `user:read:chat` even when an application requests additional state events.

## Test and replay events

The event helpers make overlay failures reproducible without requiring a live Twitch/Kick session.

```ts
import {
  ChatEventRecorder,
  createTestMessageEvent,
  replayChatEvent,
} from '@myrqyry/chatbus';

const test = createTestMessageEvent({
  platform: 'twitch',
  channelName: 'example',
  text: 'hello overlay',
});

const recorder = new ChatEventRecorder({ limit: 200 });
recorder.record(test);

const replay = replayChatEvent(test, { timestamp: Date.now() });
renderChatEvent(replay);
```

`createTestChatEvent()` and `createTestMessageEvent()` use deterministic defaults (`timestamp: 0`, stable IDs) so fixtures do not change between runs. `replayChatEvent()` marks the event with `origin: 'replay'`; generated fixtures use `origin: 'test'`. `chatEventOrigin()` treats an older event with no explicit origin as live.

`serializeChatEvent()`, `deserializeChatEvent()`, `serializeChatEvents()`, and `deserializeChatEvents()` provide JSON round-tripping with basic envelope validation. The recorder is only an in-memory bounded ring buffer; persistence remains an application decision so `Chatbus` stays framework- and storage-neutral.
