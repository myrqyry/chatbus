import { describe, expect, it } from 'vitest';
import { createTwitchEventSubSubscription, normalizeTwitchEventSubNotification } from '../src/index';
import type { TwitchAuth, TwitchEventSubEnvelope } from '../src/index';

const envelope = (subscriptionType: string, event: Record<string, unknown>): TwitchEventSubEnvelope => ({
  metadata: {
    message_id: `delivery:${subscriptionType}`,
    message_type: 'notification',
    message_timestamp: '2026-09-17T20:00:00.123456789Z',
    subscription_type: subscriptionType,
    subscription_version: subscriptionType === 'channel.update' || subscriptionType === 'channel.follow' ? '2' : '1',
  },
  payload: {
    subscription: { type: subscriptionType },
    event,
  },
});

const broadcaster = {
  broadcaster_user_id: '10',
  broadcaster_user_login: 'streamer',
  broadcaster_user_name: 'Streamer',
};

describe('Twitch extended EventSub normalization', () => {
  it('normalizes channel metadata updates', () => {
    expect(normalizeTwitchEventSubNotification(envelope('channel.update', {
      ...broadcaster,
      title: 'New title',
      language: 'en',
      category_id: '509658',
      category_name: 'Just Chatting',
      content_classification_labels: ['MatureGame'],
    }))).toMatchObject({
      type: 'channel-update',
      platform: 'twitch',
      channelId: '10',
      channelName: 'streamer',
      data: {
        title: 'New title',
        categoryName: 'Just Chatting',
        contentClassificationLabels: ['MatureGame'],
      },
    });
  });

  it('normalizes stream online/offline transitions', () => {
    expect(normalizeTwitchEventSubNotification(envelope('stream.online', {
      ...broadcaster,
      id: 'stream-1',
      type: 'live',
      started_at: '2026-09-17T19:59:00Z',
    }))).toMatchObject({
      id: 'stream-1',
      type: 'stream-online',
      data: { streamId: 'stream-1', streamType: 'live' },
    });

    expect(normalizeTwitchEventSubNotification(envelope('stream.offline', broadcaster)))
      .toMatchObject({ type: 'stream-offline', channelId: '10' });
  });

  it('normalizes follows and reward redemptions with viewer identity', () => {
    expect(normalizeTwitchEventSubNotification(envelope('channel.follow', {
      ...broadcaster,
      user_id: '20',
      user_login: 'viewer',
      user_name: 'Viewer',
      followed_at: '2026-09-17T19:58:00Z',
    }))).toMatchObject({
      type: 'follow',
      user: { id: '20', username: 'viewer', displayName: 'Viewer' },
      data: { followedAt: '2026-09-17T19:58:00Z' },
    });

    expect(normalizeTwitchEventSubNotification(envelope(
      'channel.channel_points_custom_reward_redemption.add',
      {
        ...broadcaster,
        id: 'redemption-1',
        user_id: '20',
        user_login: 'viewer',
        user_name: 'Viewer',
        user_input: 'do the thing',
        status: 'unfulfilled',
        redeemed_at: '2026-09-17T19:59:30Z',
        reward: { id: 'reward-1', title: 'Do the thing', cost: 500 },
      },
    ))).toMatchObject({
      id: 'redemption-1',
      type: 'reward-redemption',
      user: { id: '20', username: 'viewer' },
      data: {
        userInput: 'do the thing',
        status: 'unfulfilled',
        reward: { id: 'reward-1', title: 'Do the thing', cost: 500 },
      },
    });
  });

  it('normalizes bans and timeouts without collapsing them together', () => {
    expect(normalizeTwitchEventSubNotification(envelope('channel.ban', {
      ...broadcaster,
      user_id: '20',
      user_login: 'viewer',
      user_name: 'Viewer',
      moderator_user_id: '30',
      moderator_user_login: 'mod',
      reason: 'reason',
      banned_at: '2026-09-17T20:00:00Z',
      ends_at: '2026-09-17T20:10:00Z',
      is_permanent: false,
    }))).toMatchObject({
      type: 'user-timeout',
      user: { id: '20', username: 'viewer' },
      data: { moderatorUserId: '30', moderatorUsername: 'mod' },
    });

    expect(normalizeTwitchEventSubNotification(envelope('channel.ban', {
      ...broadcaster,
      user_id: '21',
      user_login: 'badviewer',
      is_permanent: true,
    }))).toMatchObject({ type: 'user-ban', user: { id: '21' } });
  });
});


describe('Twitch extended subscription requests', () => {
  it('uses current versions and condition shapes for follow and reward subscriptions', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ data: [] }), { status: 202 });
    };
    const auth: TwitchAuth = {
      clientId: 'client-1',
      accessToken: 'token-1',
      userId: 'moderator-1',
      scopes: ['user:read:chat', 'moderator:read:followers', 'channel:read:redemptions'],
    };

    try {
      await createTwitchEventSubSubscription(
        'channel.follow',
        'session-1',
        'broadcaster-1',
        auth,
      );
      await createTwitchEventSubSubscription(
        'channel.channel_points_custom_reward_redemption.add',
        'session-1',
        'broadcaster-1',
        auth,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(bodies).toEqual([
      expect.objectContaining({
        type: 'channel.follow',
        version: '2',
        condition: {
          broadcaster_user_id: 'broadcaster-1',
          moderator_user_id: 'moderator-1',
        },
      }),
      expect.objectContaining({
        type: 'channel.channel_points_custom_reward_redemption.add',
        version: '1',
        condition: { broadcaster_user_id: 'broadcaster-1' },
      }),
    ]);
  });
});
