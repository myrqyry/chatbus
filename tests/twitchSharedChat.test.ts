import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TWITCH_CHAT_SUBSCRIPTIONS,
  TWITCH_SHARED_CHAT_SUBSCRIPTIONS,
  createTwitchEventSubSubscription,
  normalizeTwitchEventSubNotification,
  planTwitchCapabilities,
} from '../src/index';
import type { TwitchAuth, TwitchEventSubEnvelope } from '../src/index';

const envelope = (type: string, event: Record<string, unknown>): TwitchEventSubEnvelope => ({
  metadata: {
    message_id: `delivery:${type}`,
    message_type: 'notification',
    message_timestamp: '2026-10-15T20:00:00.123456789Z',
    subscription_type: type,
    subscription_version: '1',
  },
  payload: { subscription: { type, version: '1' }, event },
});

const channel = {
  broadcaster_user_id: '10',
  broadcaster_user_login: 'destination',
  broadcaster_user_name: 'Destination',
};

describe('Twitch shared social context', () => {
  it('preserves original channel, source badges, and source-only for shared chat notifications', () => {
    const result = normalizeTwitchEventSubNotification(envelope('channel.chat.notification', {
      ...channel,
      notice_type: 'shared_chat_sub',
      chatter_user_id: '20',
      chatter_user_login: 'viewer',
      chatter_user_name: 'Viewer',
      message_id: 'relay-message',
      message: { text: 'six months!', fragments: [{ type: 'text', text: 'six months!' }] },
      source_broadcaster_user_id: '99',
      source_broadcaster_user_login: 'origin',
      source_broadcaster_user_name: 'Origin',
      source_message_id: 'original-message',
      source_badges: [{ set_id: 'subscriber', id: '6', info: '6' }],
      is_source_only: false,
    }));
    expect(result).toMatchObject({
      type: 'subscription', platform: 'twitch', channelId: '10',
      message: {
        id: 'relay-message',
        source: {
          channelId: '99', channelName: 'origin', displayName: 'Origin',
          messageId: 'original-message', sourceOnly: false,
          badgeRefs: [{ provider: 'twitch', id: 'subscriber', version: '6', info: '6' }],
        },
      },
    });
    expect(result?.message?.text).toBe('six months!');
  });

  it('does not invent a source channel for ordinary chat notifications', () => {
    const result = normalizeTwitchEventSubNotification(envelope('channel.chat.notification', {
      ...channel,
      notice_type: 'resub',
      chatter_user_id: '20', chatter_user_login: 'viewer',
      message_id: 'ordinary-message',
      message: { text: 'hi!' },
      source_broadcaster_user_id: null,
      source_message_id: null,
      source_badges: null,
      is_source_only: null,
    }));
    expect(result?.message?.source).toBeUndefined();
  });

  it.each(['begin', 'update', 'end'] as const)(
    'normalizes shared-chat session %s events as non-rendered room state',
    (phase) => {
      const event = {
        ...channel,
        session_id: 'session-1',
        host_broadcaster_user_id: '50',
        host_broadcaster_user_login: 'host',
        host_broadcaster_user_name: 'Host',
        ...(phase === 'end' ? {} : {
          participants: [
            { broadcaster_user_id: '50', broadcaster_user_login: 'host', broadcaster_user_name: 'Host' },
            { broadcaster_user_id: '10', broadcaster_user_login: 'destination', broadcaster_user_name: 'Destination' },
          ],
        }),
      };
      const result = normalizeTwitchEventSubNotification(envelope(`channel.shared_chat.${phase}`, event));
      expect(result).toMatchObject({
        type: 'room-state',
        platform: 'twitch',
        id: `delivery:channel.shared_chat.${phase}`,
        channelId: '10',
        channelName: 'destination',
        timestamp: Date.parse('2026-10-15T20:00:00.123Z'),
        data: {
          kind: 'shared-chat-session', phase, sessionId: 'session-1',
          host: { id: '50', login: 'host', displayName: 'Host' },
        },
      });
      if (phase === 'end') {
        expect((result?.data as Record<string, unknown>)?.participants).toBeUndefined();
      } else {
        expect((result?.data as Record<string, unknown>)?.participants).toEqual([
          { id: '50', login: 'host', displayName: 'Host' },
          { id: '10', login: 'destination', displayName: 'Destination' },
        ]);
      }
    },
  );

  it('rejects a shared-chat session without a real session or broadcaster identifier', () => {
    expect(normalizeTwitchEventSubNotification(envelope('channel.shared_chat.begin', {
      ...channel, participants: [],
    }))).toBeNull();
    expect(normalizeTwitchEventSubNotification(envelope('channel.shared_chat.end', {
      session_id: 'session-1', host_broadcaster_user_id: '50',
    }))).toBeNull();
  });
});

describe('Twitch shared-chat opt-in subscription wiring', () => {
  it('plans three scope-free subscriptions without changing the default chat set', () => {
    const plan = planTwitchCapabilities(['shared-chat'], {
      broadcasterUserId: '10',
      userId: '20',
      scopes: [],
    });
    expect(TWITCH_SHARED_CHAT_SUBSCRIPTIONS).toEqual([
      'channel.shared_chat.begin',
      'channel.shared_chat.update',
      'channel.shared_chat.end',
    ]);
    expect(DEFAULT_TWITCH_CHAT_SUBSCRIPTIONS).not.toContain('channel.shared_chat.begin');
    expect(plan.subscriptions.map(s => s.type)).toEqual(TWITCH_SHARED_CHAT_SUBSCRIPTIONS);
    expect(plan.subscriptions.every(s => s.ready && s.handledByChatbus)).toBe(true);
    expect(plan.subscriptions.every(s => s.version === '1')).toBe(true);
    expect(plan.subscriptions.every(s =>
      JSON.stringify(s.conditionValues) === '{"broadcaster_user_id":"10"}')).toBe(true);
    expect(plan.missingScopeRequirements).toEqual([]);
  });

  it('creates native EventSub subscription requests with the broadcaster-only condition', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [] }), { status: 202 }));
    const priorFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    const auth: TwitchAuth = {
      clientId: 'client', accessToken: 'token', userId: '20', scopes: ['user:read:chat'],
    };
    try {
      await createTwitchEventSubSubscription('channel.shared_chat.begin', 'socket-1', '10', auth);
      expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
        type: 'channel.shared_chat.begin',
        version: '1',
        condition: { broadcaster_user_id: '10' },
        transport: { method: 'websocket', session_id: 'socket-1' },
      });
    } finally {
      globalThis.fetch = priorFetch;
    }
  });
});
