import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TWITCH_CHAT_SUBSCRIPTIONS,
  TWITCH_CAPABILITY_REGISTRY,
  planTwitchCapabilities,
  twitchSubscriptionMissingScopeRequirements,
} from '../src/index';

describe('Twitch capability planning', () => {
  it('keeps the chat capability aligned with the actual chat subscription set', () => {
    expect(TWITCH_CAPABILITY_REGISTRY.chat.subscriptions.map((subscription) => subscription.type))
      .toEqual(DEFAULT_TWITCH_CHAT_SUBSCRIPTIONS);

    const plan = planTwitchCapabilities(['chat'], {
      broadcasterUserId: 'broadcaster',
      userId: 'reader',
      scopes: ['user:read:chat'],
    });

    expect(plan.capabilities[0]).toMatchObject({
      id: 'chat',
      ready: true,
      partial: false,
    });
    expect(plan.subscriptions).toHaveLength(DEFAULT_TWITCH_CHAT_SUBSCRIPTIONS.length);
    expect(plan.subscriptions.every((subscription) => subscription.ready)).toBe(true);
    expect(plan.subscriptions.every((subscription) => subscription.handledByChatbus)).toBe(true);
    expect(plan.subscriptions.every((subscription) => subscription.handledByChatCore === subscription.handledByChatbus)).toBe(true);
    expect(plan.subscriptions[0].conditionValues).toEqual({
      broadcaster_user_id: 'broadcaster',
      user_id: 'reader',
    });
  });

  it('reports missing follower scope without losing the resolved condition', () => {
    const plan = planTwitchCapabilities(['followers'], {
      broadcasterUserId: 'broadcaster',
      userId: 'moderator',
      scopes: [],
    });

    expect(plan.capabilities[0]).toMatchObject({
      id: 'followers',
      ready: false,
      partial: false,
    });
    expect(plan.subscriptions[0]).toMatchObject({
      type: 'channel.follow',
      version: '2',
      ready: false,
      handledByChatbus: true,
      conditionValues: {
        broadcaster_user_id: 'broadcaster',
        moderator_user_id: 'moderator',
      },
    });
    expect(plan.missingScopeRequirements).toEqual([
      { anyOf: ['moderator:read:followers'] },
    ]);
    expect(plan.suggestedScopes).toEqual(['moderator:read:followers']);
  });

  it('handles moderation scope alternatives per subscription instead of all-or-nothing', () => {
    const plan = planTwitchCapabilities(['moderation'], {
      broadcasterUserId: 'broadcaster',
      userId: 'moderator',
      scopes: [
        'moderator:manage:blocked_terms',
        'moderator:read:chat_settings',
        'moderator:manage:unban_requests',
        'moderator:read:banned_users',
        'moderator:manage:chat_messages',
        'moderator:read:warnings',
        'moderator:read:moderators',
        'moderator:read:vips',
      ],
    });

    expect(plan.capabilities[0]).toMatchObject({
      id: 'moderation',
      ready: false,
      partial: true,
    });
    expect(plan.subscriptions.find((subscription) => subscription.type === 'channel.moderate'))
      .toMatchObject({ version: '2', ready: true });
    expect(plan.subscriptions.find((subscription) => subscription.type === 'channel.ban'))
      .toMatchObject({ version: '1', ready: false });
    expect(plan.missingScopeRequirements).toEqual([{ anyOf: ['channel:moderate'] }]);
  });

  it('keeps channel.ban on Twitch\'s channel:moderate scope', () => {
    const ready = planTwitchCapabilities(['moderation'], {
      broadcasterUserId: 'broadcaster',
      userId: 'moderator',
      scopes: ['channel:moderate'],
    });

    expect(ready.subscriptions.find((subscription) => subscription.type === 'channel.ban'))
      .toMatchObject({ version: '1', ready: true });
    expect(twitchSubscriptionMissingScopeRequirements(
      ['channel.ban'],
      ['channel:moderate'],
    )).toEqual([]);
    expect(twitchSubscriptionMissingScopeRequirements(
      ['channel.ban'],
      ['moderator:read:banned_users'],
    )).toEqual([['channel:moderate']]);
  });

  it('uses current versions for scope-free state capabilities', () => {
    const plan = planTwitchCapabilities(['channel-state', 'stream-state'], {
      broadcasterUserId: 'broadcaster',
      userId: 'reader',
    });

    expect(plan.subscriptions.map(({ type, version, ready }) => ({ type, version, ready }))).toEqual([
      { type: 'channel.update', version: '2', ready: true },
      { type: 'stream.online', version: '1', ready: true },
      { type: 'stream.offline', version: '1', ready: true },
    ]);
    expect(plan.missingScopeRequirements).toEqual([]);
  });

  it('plans reward redemptions with read/manage scope alternatives', () => {
    const plan = planTwitchCapabilities(['rewards'], {
      broadcasterUserId: 'broadcaster',
      userId: 'reader',
      scopes: ['channel:manage:redemptions'],
    });

    expect(plan.capabilities[0]).toMatchObject({ id: 'rewards', ready: true, partial: false });
    expect(plan.subscriptions[0]).toMatchObject({
      type: 'channel.channel_points_custom_reward_redemption.add',
      handledByChatbus: true,
      ready: true,
      conditionValues: { broadcaster_user_id: 'broadcaster' },
    });
    expect(twitchSubscriptionMissingScopeRequirements(
      ['channel.channel_points_custom_reward_redemption.add'],
      ['channel:manage:redemptions'],
    )).toEqual([]);
    expect(twitchSubscriptionMissingScopeRequirements(
      ['channel.channel_points_custom_reward_redemption.add'],
      [],
    )).toEqual([['channel:read:redemptions', 'channel:manage:redemptions']]);
  });

});
