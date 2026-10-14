import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectTwitchChat,
  createTwitchEventSubSocket,
  normalizeTwitchEventSubNotification,
  parseTwitchEventSubFrame,
  resolveTwitchEventSubAuth,
} from '../src/index';

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  readonly url: string;
  closeCount = 0;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.closeCount += 1;
  }

  emitOpen(): void {
    this.onopen?.({} as Event);
  }

  emitMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<unknown>);
  }

  emitClose(): void {
    this.onclose?.({} as CloseEvent);
  }
}

const welcome = (id = 'session-1', keepalive = 30) => ({
  metadata: {
    message_id: `welcome-${id}`,
    message_type: 'session_welcome',
    message_timestamp: '2026-09-12T20:00:00.123456789Z',
  },
  payload: {
    session: {
      id,
      status: 'connected',
      keepalive_timeout_seconds: keepalive,
      reconnect_url: null,
    },
  },
});

const chatMessage = (messageId = 'message-1') => ({
  metadata: {
    message_id: `delivery-${messageId}`,
    message_type: 'notification',
    message_timestamp: '2026-09-12T20:00:00.123456789Z',
    subscription_type: 'channel.chat.message',
    subscription_version: '1',
  },
  payload: {
    subscription: { type: 'channel.chat.message', version: '1' },
    event: {
      broadcaster_user_id: '10',
      broadcaster_user_login: 'streamer',
      broadcaster_user_name: 'Streamer',
      chatter_user_id: '20',
      chatter_user_login: 'viewer',
      chatter_user_name: 'Viewer',
      message_id: messageId,
      message: {
        text: 'hello Kappa @friend Cheer100',
        fragments: [
          { type: 'text', text: 'hello ' },
          {
            type: 'emote',
            text: 'Kappa',
            emote: { id: '25', emote_set_id: '0', owner_id: '0', format: ['static'] },
          },
          { type: 'text', text: ' ' },
          {
            type: 'mention',
            text: '@friend',
            mention: { user_id: '30', user_login: 'friend', user_name: 'Friend' },
          },
          { type: 'text', text: ' ' },
          {
            type: 'cheermote',
            text: 'Cheer100',
            cheermote: { prefix: 'cheer', bits: 100, tier: 100 },
          },
        ],
      },
      color: '#00FF7F',
      badges: [
        { set_id: 'moderator', id: '1', info: '' },
        { set_id: 'subscriber', id: '12', info: '16' },
      ],
      message_type: 'channel_points_highlighted',
      cheer: { bits: 100 },
      reply: { parent_message_id: 'parent-1' },
      channel_points_custom_reward_id: 'reward-1',
    },
  },
});

describe('Twitch EventSub protocol', () => {
  it('parses valid frames and rejects malformed data', () => {
    expect(parseTwitchEventSubFrame(JSON.stringify(welcome()))).toMatchObject({
      metadata: { message_type: 'session_welcome' },
      payload: { session: { id: 'session-1' } },
    });
    expect(parseTwitchEventSubFrame('not json')).toBeNull();
    expect(parseTwitchEventSubFrame(JSON.stringify({ metadata: {}, payload: {} }))).toBeNull();
  });
});

describe('Twitch normalization', () => {
  it('preserves native emotes, mentions, Bits, badges, replies, and message traits', () => {
    const envelope = parseTwitchEventSubFrame(JSON.stringify(chatMessage()));
    expect(envelope).not.toBeNull();
    const event = normalizeTwitchEventSubNotification(envelope!);

    expect(event).toMatchObject({
      id: 'message-1',
      type: 'cheer',
      platform: 'twitch',
      channelId: '10',
      channelName: 'streamer',
      user: {
        id: '20',
        username: 'viewer',
        roles: ['moderator', 'subscriber'],
        badgeRefs: [
          { id: 'moderator', provider: 'twitch', version: '1' },
          { id: 'subscriber', provider: 'twitch', version: '12', info: '16' },
        ],
      },
      message: {
        replyToMessageId: 'parent-1',
        traits: {
          messageType: 'channel_points_highlighted',
          highlighted: true,
          firstMessage: false,
          emoteOnly: false,
          customRewardId: 'reward-1',
        },
      },
      data: { bits: 100 },
    });

    expect(event?.message?.fragments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'emote',
        text: 'Kappa',
        emote: expect.objectContaining({ id: '25', provider: 'twitch' }),
      }),
      expect.objectContaining({
        type: 'mention',
        text: '@friend',
        username: 'friend',
        userId: '30',
      }),
      expect.objectContaining({
        type: 'cheermote',
        text: 'Cheer100',
        bits: 100,
        prefix: 'cheer',
      }),
    ]));
  });

  it('maps chat notifications without pretending every notice is the same event', () => {
    const envelope = parseTwitchEventSubFrame(JSON.stringify({
      metadata: {
        message_id: 'delivery-resub',
        message_type: 'notification',
        message_timestamp: '2026-09-12T20:00:00Z',
        subscription_type: 'channel.chat.notification',
      },
      payload: {
        subscription: { type: 'channel.chat.notification' },
        event: {
          broadcaster_user_id: '10',
          broadcaster_user_login: 'streamer',
          chatter_user_id: '20',
          chatter_user_login: 'viewer',
          message_id: 'notice-1',
          notice_type: 'resub',
          resub: { cumulative_months: 10 },
        },
      },
    }));

    expect(normalizeTwitchEventSubNotification(envelope!)).toMatchObject({
      type: 'subscription',
      data: { kind: 'chat-notification', noticeType: 'resub' },
    });
  });
});

describe('Twitch auth', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts oauth-prefixed user tokens and verifies user:read:chat', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      client_id: 'client-1',
      user_id: 'user-1',
      login: 'bot',
      scopes: ['user:read:chat'],
      expires_in: 3600,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveTwitchEventSubAuth('oauth:token-1')).resolves.toMatchObject({
      clientId: 'client-1',
      userId: 'user-1',
      accessToken: 'token-1',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://id.twitch.tv/oauth2/validate',
      expect.objectContaining({
        headers: { Authorization: 'OAuth token-1' },
      }),
    );
  });
});

describe('Twitch EventSub socket lifecycle', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('waits for welcome readiness and honors Twitch keepalive negotiation', async () => {
    const states: string[] = [];
    const handle = createTwitchEventSubSocket({
      onStateChange: (state) => states.push(state),
      onWelcome: async () => {},
    });
    const ws = MockWebSocket.instances[0];

    ws.emitOpen();
    expect(states).toEqual(['connecting']);

    ws.emitMessage(welcome('session-1', 120));
    await Promise.resolve();
    await Promise.resolve();
    expect(states.at(-1)).toBe('connected');

    vi.advanceTimersByTime(124_000);
    expect(ws.closeCount).toBe(0);
    vi.advanceTimersByTime(2_000);
    expect(ws.closeCount).toBe(1);

    handle.close();
  });

  it('uses Twitch reconnect URLs as a handoff and closes the old socket only after new welcome', async () => {
    const welcomeKinds: boolean[] = [];
    const handle = createTwitchEventSubSocket({
      onWelcome: async (_session, context) => {
        welcomeKinds.push(context.isServerReconnect);
      },
    });

    const first = MockWebSocket.instances[0];
    first.emitOpen();
    first.emitMessage(welcome('old-session'));
    await Promise.resolve();
    await Promise.resolve();

    first.emitMessage({
      metadata: {
        message_id: 'reconnect-1',
        message_type: 'session_reconnect',
        message_timestamp: '2026-09-12T20:00:01Z',
      },
      payload: {
        session: {
          id: 'old-session',
          reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?reconnect=abc',
        },
      },
    });

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(first.closeCount).toBe(0);

    const second = MockWebSocket.instances[1];
    second.emitOpen();
    second.emitMessage(welcome('new-session'));
    await Promise.resolve();
    await Promise.resolve();

    expect(welcomeKinds).toEqual([false, true]);
    expect(first.closeCount).toBe(1);

    handle.close();
  });

  it('deduplicates at-least-once EventSub notification delivery in the connector', async () => {
    vi.useRealTimers();
    const events: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/oauth2/validate')) {
        return new Response(JSON.stringify({
          client_id: 'client-1',
          user_id: 'user-1',
          login: 'bot',
          scopes: ['user:read:chat'],
        }), { status: 200 });
      }
      if (url.includes('/helix/users')) {
        return new Response(JSON.stringify({
          data: [{ id: '10', login: 'streamer', display_name: 'Streamer' }],
        }), { status: 200 });
      }
      if (url.includes('/helix/eventsub/subscriptions')) {
        return new Response(JSON.stringify({ data: [] }), { status: 202 });
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const connection = await connectTwitchChat({
      channel: 'streamer',
      accessToken: 'token-1',
      onEvent: (event) => events.push(event),
    });

    const ws = MockWebSocket.instances[0];
    ws.emitOpen();
    ws.emitMessage(welcome('session-1'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const duplicate = chatMessage('same-message');
    ws.emitMessage(duplicate);
    ws.emitMessage(duplicate);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 'same-message', platform: 'twitch', origin: 'live' });

    connection.close();
  });
});
