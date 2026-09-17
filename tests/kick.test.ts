import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createKickSocket,
  normalizeKickEvent,
  parseKickMessageContent,
  parseKickPusherFrame,
} from '../src/index';

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  closeCount = 0;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCount += 1;
  }

  emitOpen(): void {
    this.onopen?.({} as Event);
  }

  emitMessage(data: string): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }

  emitClose(): void {
    this.onclose?.({} as CloseEvent);
  }
}

describe('Kick protocol', () => {
  it('parses supported Pusher events and ignores control or malformed frames', () => {
    const frame = JSON.stringify({
      event: 'App\\Events\\ChatMessageEvent',
      data: JSON.stringify({
        id: 'message-1',
        chatroom_id: 42,
        content: 'hello',
        created_at: '2026-09-12T18:00:00Z',
        sender: { id: 7, username: 'viewer' },
      }),
    });

    expect(parseKickPusherFrame(frame)).toMatchObject({
      type: 'ChatMessage',
      data: { id: 'message-1', content: 'hello' },
    });
    expect(parseKickPusherFrame(JSON.stringify({ event: 'pusher:ping', data: '{}' }))).toBeNull();
    expect(parseKickPusherFrame(JSON.stringify({
      event: 'App\\Events\\ChatMessageEvent',
      data: JSON.stringify({ id: 'broken' }),
    }))).toBeNull();
    expect(parseKickPusherFrame(JSON.stringify({
      event: 'App\\Events\\ChannelSubscriptionEvent',
      data: JSON.stringify({ id: 99, user: { id: 8, username: 'subscriber' } }),
    }))).toMatchObject({ type: 'ChannelSubscription' });
    expect(parseKickPusherFrame(JSON.stringify({
      event: 'App\\Events\\LuckyUsersWhoGotGiftSubscriptionsEvent',
      data: JSON.stringify({ gifted_usernames: ['lucky'] }),
    }))).toMatchObject({ type: 'LuckyGiftedSubscriptions' });
  });
});

describe('Kick emotes', () => {
  it('turns native markers into display text plus native emote spans', () => {
    const parsed = parseKickMessageContent('yo [emote:37226:KEKW] wow');

    expect(parsed.text).toBe('yo KEKW wow');
    expect(parsed.nativeEmotes).toHaveLength(1);
    expect(parsed.nativeEmotes[0]).toMatchObject({
      id: '37226',
      start: 3,
      end: 6,
      provider: 'kick',
      emote: {
        id: '37226',
        code: 'KEKW',
        provider: 'kick',
        url: 'https://d2egosedh0nm8l.cloudfront.net/emotes/37226/fullsize',
      },
    });
  });
});

describe('Kick normalization', () => {
  it('normalizes messages, native emotes, badges, and replies', () => {
    const event = normalizeKickEvent({
      type: 'ChatMessage',
      data: {
        id: 'message-1',
        chatroom_id: 42,
        content: 'yo [emote:37226:KEKW]',
        created_at: '2026-09-12T18:00:00Z',
        sender: {
          id: 7,
          username: 'viewer',
          identity: {
            color: '#53fc18',
            badges: [{ type: 'subscriber', text: 'Subscriber', count: 3 }],
          },
        },
        metadata: {
          original_message: { id: 'parent-1', content: 'hey' },
        },
      },
    }, { channelName: 'example' });

    expect(event).toMatchObject({
      id: 'message-1',
      type: 'message',
      platform: 'kick',
      channelId: '42',
      channelName: 'example',
      user: {
        id: '7',
        username: 'viewer',
        roles: ['subscriber'],
        badgeRefs: [{ id: 'subscriber', provider: 'kick', version: '3' }],
      },
      message: {
        text: 'yo KEKW',
        replyToMessageId: 'parent-1',
      },
    });
    expect(event?.message?.fragments[1]).toMatchObject({
      type: 'emote',
      text: 'KEKW',
      emote: { id: '37226', provider: 'kick' },
    });
  });

  it('keeps Kick host/poll/pin semantics as system events instead of calling them raids', () => {
    expect(normalizeKickEvent({
      type: 'StreamHost',
      data: { host_username: 'hoster', number_viewers: 12 },
    }, { now: () => 123 })).toMatchObject({
      type: 'system',
      timestamp: 123,
      data: { kind: 'host', host_username: 'hoster', number_viewers: 12 },
    });
  });

  it('normalizes channel-level subscription events used outside the chatroom feed', () => {
    expect(normalizeKickEvent({
      type: 'ChannelSubscription',
      data: { id: 99, user: { id: 8, username: 'subscriber' } },
    })).toMatchObject({
      id: '99',
      type: 'subscription',
      user: { id: '8', username: 'subscriber' },
      data: { kind: 'channel-subscription' },
    });
    expect(normalizeKickEvent({
      type: 'LuckyGiftedSubscriptions',
      data: { id: 'gift-1', gifter_username: 'gifter', gifted_usernames: ['lucky'] },
    })).toMatchObject({
      id: 'gift-1',
      type: 'gift-subscription',
      user: { username: 'gifter' },
      data: { kind: 'lucky-gift-subscriptions', giftedUsernames: ['lucky'] },
    });
  });
});

describe('Kick socket lifecycle', () => {
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

  it('waits for Pusher readiness and honors the negotiated activity timeout', () => {
    const states: string[] = [];
    const handle = createKickSocket(42, {
      onStateChange: (state) => states.push(state),
    });
    const ws = MockWebSocket.instances[0];

    ws.emitOpen();
    expect(states).toEqual(['connecting']);
    expect(ws.sent).toEqual([]);

    ws.emitMessage(JSON.stringify({
      event: 'pusher:connection_established',
      data: JSON.stringify({ socket_id: '1.2', activity_timeout: 120 }),
    }));
    expect(JSON.parse(ws.sent[0])).toMatchObject({
      event: 'pusher:subscribe',
      data: { channel: 'chatrooms.42.v2' },
    });

    ws.emitMessage(JSON.stringify({
      event: 'pusher_internal:subscription_succeeded',
      channel: 'chatrooms.42.v2',
      data: '{}',
    }));
    expect(states.at(-1)).toBe('connected');

    vi.advanceTimersByTime(95_000);
    expect(ws.closeCount).toBe(0);

    handle.close();
  });

  it('subscribes to both chatroom and channel feeds before declaring readiness', () => {
    const states: string[] = [];
    const handle = createKickSocket(42, {
      channelId: '99',
      onStateChange: (state) => states.push(state),
    });
    const ws = MockWebSocket.instances[0];
    ws.emitOpen();
    ws.emitMessage(JSON.stringify({
      event: 'pusher:connection_established',
      data: JSON.stringify({ socket_id: '1.2', activity_timeout: 120 }),
    }));
    expect(ws.sent.map((entry) => JSON.parse(entry).data.channel)).toEqual([
      'chatrooms.42.v2',
      'channel.99',
    ]);

    ws.emitMessage(JSON.stringify({
      event: 'pusher_internal:subscription_succeeded',
      channel: 'chatrooms.42.v2',
      data: '{}',
    }));
    expect(states.at(-1)).toBe('connecting');

    ws.emitMessage(JSON.stringify({
      event: 'pusher_internal:subscription_succeeded',
      channel: 'channel.99',
      data: '{}',
    }));
    expect(states.at(-1)).toBe('connected');
    handle.close();
  });

  it('keeps exponential backoff across WebSocket opens until Pusher is usable', () => {
    const handle = createKickSocket(42);

    const first = MockWebSocket.instances[0];
    first.emitOpen();
    first.emitClose();

    vi.advanceTimersByTime(999);
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    const second = MockWebSocket.instances[1];
    second.emitOpen();
    second.emitClose();

    vi.advanceTimersByTime(1_000);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    expect(MockWebSocket.instances).toHaveLength(3);

    const third = MockWebSocket.instances[2];
    third.emitOpen();
    third.emitMessage(JSON.stringify({
      event: 'pusher:connection_established',
      data: JSON.stringify({ socket_id: '3.4', activity_timeout: 120 }),
    }));
    third.emitMessage(JSON.stringify({
      event: 'pusher_internal:subscription_succeeded',
      channel: 'chatrooms.42.v2',
      data: '{}',
    }));
    third.emitClose();

    vi.advanceTimersByTime(1_000);
    expect(MockWebSocket.instances).toHaveLength(4);

    handle.close();
  });
});
