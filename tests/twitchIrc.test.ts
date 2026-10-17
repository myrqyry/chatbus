import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { parseTwitchIrcLine, normalizeTwitchIrcFrame, connectTwitchIrcChat } from '../src/index';

const parse = (line: string) => {
  const frame = parseTwitchIrcLine(line);
  if (!frame) throw new Error('Invalid test IRC line');
  return frame;
};

const privmsg = (text = 'Kappa hello') =>
  '@id=message-1;user-id=42;room-id=10;display-name=Viewer;color=#00FF99;badges=subscriber/6,moderator/1;emotes=25:0-4;tmi-sent-ts=1792200000000;bits=0;reply-parent-msg-id=parent-1;source-room-id=99;source-id=original-1;source-only=0 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #host :' + text;

class FakeWebSocket {
  static sockets: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  readonly sent: string[] = [];
  closeCount = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(readonly url: string) { FakeWebSocket.sockets.push(this); }
  send(line: string) { this.sent.push(line); }
  close() { this.closeCount++; this.onclose?.({ code: 1000 } as CloseEvent); }
  open() { this.onopen?.({} as Event); }
  receive(data: string) { this.onmessage?.({ data } as MessageEvent<string>); }
  drop() { this.onclose?.({ code: 1006 } as CloseEvent); }
}
const connected = ':tmi.twitch.tv 001 justinfan12345 :Welcome, GLHF!\r\n@room-id=10 :tmi.twitch.tv ROOMSTATE #host\r\n';

describe('Twitch IRC exact parser and normalized events', () => {
  it('parses exact IRC command boundaries, trailing whitespace and escaped tags', () => {
    expect(parseTwitchIrcLine('@display-name=A\\sB;msg-param=something\\:else\\\\hey\\r\\n :nick!x@y PRIVMSG #HOST :look PRIVMSG again')).toMatchObject({
      command: 'PRIVMSG', params: ['#HOST', 'look PRIVMSG again'],
      tags: { 'display-name': 'A B', 'msg-param': 'something;else\\hey\r\n' },
    });
    expect(parseTwitchIrcLine(':malformed PRIVMSGJUNK #host :not chat')?.command).toBe('PRIVMSGJUNK');
    expect(parseTwitchIrcLine('garbage!')).toBeNull();
    expect(parseTwitchIrcLine('PRIVMSG #host :hi\r\n')).toMatchObject({ command: 'PRIVMSG', params: ['#host', 'hi'] });
  });

  it('preserves emote offsets, user identity, badges, reply and shared-chat source', () => {
    const event = normalizeTwitchIrcFrame(parse(privmsg()), { channel: 'host' });
    expect(event).toMatchObject({
      id: 'message-1', platform: 'twitch', type: 'message', channelId: '10', channelName: 'host',
      timestamp: 1792200000000,
      message: {
        id: 'message-1', text: 'Kappa hello', replyToMessageId: 'parent-1',
        user: { id: '42', username: 'viewer', color: '#00FF99',
          badgeRefs: [{ provider: 'twitch', id: 'subscriber', version: '6' }, { provider: 'twitch', id: 'moderator', version: '1' }] },
        source: { channelId: '99', messageId: 'original-1', sourceOnly: false },
      },
    });
    expect(event?.message?.fragments[0]).toMatchObject({ type: 'emote', emote: { id: '25', code: 'Kappa' } });
    expect(event?.origin).toBeUndefined();
  });

  it('rejects channel spoofing and command-string matches in text', () => {
    expect(normalizeTwitchIrcFrame(parse(privmsg().replace('PRIVMSG #host', 'PRIVMSG #other')), { channel: 'host' })).toBeNull();
    expect(normalizeTwitchIrcFrame(parse(':viewer!x@y NOTICE #host :PRIVMSG fake'), { channel: 'host' })).toBeNull();
    expect(normalizeTwitchIrcFrame(parse(':viewer!x@y PRIVMSG #host :hi PRIVMSG you'), { channel: 'host', fallbackId: 'local-1' })?.message?.text).toBe('hi PRIVMSG you');
  });

  it('preserves cheer vs ordinary chat and never routes subscriptions as commands', () => {
    expect(normalizeTwitchIrcFrame(parse(privmsg('Kappa Cheer100').replace('bits=0', 'bits=100')), { channel: 'host' }))
      .toMatchObject({ type: 'cheer', data: { bits: 100 } });
    const sub = normalizeTwitchIrcFrame(parse('@id=notice1;msg-id=resub;user-id=42;display-name=Viewer :tmi.twitch.tv USERNOTICE #host :six months'), { channel: 'host' });
    expect(sub).toMatchObject({ type: 'subscription', message: { text: 'six months' }, data: { noticeType: 'resub' } });
  });

  it('normalizes moderation target IDs, channel clears, timeouts and room state', () => {
    expect(normalizeTwitchIrcFrame(parse('@room-id=10;target-msg-id=gone;tmi-sent-ts=1792200000200 :tmi.twitch.tv CLEARMSG #host :deleted'), { channel: 'host' }))
      .toMatchObject({ type: 'message-delete', data: { messageId: 'gone' }, channelId: '10' });
    expect(normalizeTwitchIrcFrame(parse('@room-id=10;target-user-id=7;ban-duration=600 :tmi.twitch.tv CLEARCHAT #host :viewer'), { channel: 'host' }))
      .toMatchObject({ type: 'user-timeout', user: { id: '7', username: 'viewer' }, data: { durationSeconds: 600 } });
    expect(normalizeTwitchIrcFrame(parse(':tmi.twitch.tv CLEARCHAT #host'), { channel: 'host' }))
      .toMatchObject({ type: 'system', data: { kind: 'chat-clear' } });
    expect(normalizeTwitchIrcFrame(parse('@room-id=10;slow=30;emote-only=0 :tmi.twitch.tv ROOMSTATE #host'), { channel: 'host' }))
      .toMatchObject({ type: 'room-state', data: { kind: 'chat-settings', slow: 30 } });
    expect(normalizeTwitchIrcFrame(parse(':tmi.twitch.tv CLEARMSG #host :untargeted'), { channel: 'host' })).toBeNull();
  });

  it('retains IRC raid viewer counts and delivers message-bearing milestone notices as chat', () => {
    const raid = normalizeTwitchIrcFrame(parse(
      '@id=raid-1;msg-id=raid;msg-param-viewerCount=123;display-name=Raider :tmi.twitch.tv USERNOTICE #host'
    ), { channel: 'host' });
    expect(raid).toMatchObject({ type: 'raid', user: { username: 'raider', displayName: 'Raider' }, data: { kind: 'chat-notification', viewers: 123 } });

    const milestone = normalizeTwitchIrcFrame(parse(
      '@id=notice-1;msg-id=viewermilestone;user-id=42;display-name=Viewer :viewer!viewer@tmi.twitch.tv USERNOTICE #host :I am back!'
    ), { channel: 'host' });
    expect(milestone).toMatchObject({
      type: 'message', message: { id: 'notice-1', text: 'I am back!' },
      data: { kind: 'chat-notification', noticeType: 'viewermilestone' },
    });
  });

  it('handles missing Twitch tags with local fallback identity but without fabricating upstream identities', () => {
    const event = normalizeTwitchIrcFrame(parse(':viewer!viewer@host PRIVMSG #host :plain'), { channel: 'host', fallbackId: 'irc-local-1' });
    expect(event).toMatchObject({ type: 'message', message: { id: 'irc-local-1', user: { username: 'viewer' }, text: 'plain' } });
    expect(event?.user?.id).toBeUndefined();
    expect(normalizeTwitchIrcFrame(parse(':viewer!viewer@host PRIVMSG #host :plain'), { channel: 'host' })).toBeNull();
  });
});

describe('Anonymous Twitch IRC connector lifecycle', () => {
  const connections: Array<{ close: () => void }> = [];
  let events: Array<{ type: string; origin?: string; message?: { text: string } }>;
  let states: string[];
  let errors: Error[];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    FakeWebSocket.sockets = [];
    events = []; states = []; errors = [];
  });
  afterEach(() => {
    connections.splice(0).forEach((c) => c.close());
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const start = (overrides: Record<string, unknown> = {}) => {
    const connection = connectTwitchIrcChat({
      channel: 'HOST', nickname: 'justinfan12345',
      reconnectBaseDelayMs: 1000, reconnectMaxDelayMs: 2000,
      onEvent: (event) => events.push(event),
      onStateChange: (state) => states.push(state),
      onError: (error) => errors.push(error),
      ...overrides,
    });
    connections.push(connection);
    return connection;
  };

  it('starts a receive-only anonymous session and becomes ready on real room acknowledgement', () => {
    start();
    const socket = FakeWebSocket.sockets[0]!;
    expect(socket.url).toBe('wss://irc-ws.chat.twitch.tv:443');
    socket.open();
    expect(socket.sent.join('\n')).toContain('PASS SCHMOOPIIE');
    expect(socket.sent.join('\n')).toContain('NICK justinfan12345');
    expect(socket.sent.join('\n')).toContain('CAP REQ :twitch.tv/tags twitch.tv/commands');
    expect(socket.sent.join('\n')).toContain('JOIN #host');
    expect(states).not.toContain('connected');
    socket.receive(':tmi.twitch.tv 001 justinfan12345 :Welcome\r\n');
    expect(states).not.toContain('connected');
    socket.receive('@room-id=10 :tmi.twitch.tv ROOMSTATE #host\r\n');
    expect(states.at(-1)).toBe('connected');
    socket.receive(privmsg() + '\r\n');
    expect(events.at(-1)).toMatchObject({ type: 'message', origin: 'live', message: { text: 'Kappa hello' } });
    expect(socket.sent.some((line) => line.startsWith('PRIVMSG'))).toBe(false);
  });

  it('handles PING/PONG and IRC data split across WebSocket frames and multiple commands', () => {
    start();
    const socket = FakeWebSocket.sockets[0]!;
    socket.open();
    socket.receive('PING :tmi.twitch.tv\r\n' + privmsg('first').slice(0, 50));
    expect(socket.sent.at(-1)).toBe('PONG :tmi.twitch.tv\r\n');
    expect(events).toHaveLength(0);
    socket.receive(privmsg('first').slice(50) + '\r\n' + privmsg('second').replace('id=message-1', 'id=message-2') + '\r\n');
    expect(events.map((e) => e.message?.text)).toEqual(['first', 'second']);
  });

  it('does not call connected merely because a socket opened, and reconnects after clean server RECONNECT', async () => {
    start();
    const a = FakeWebSocket.sockets[0]!;
    a.open();
    a.receive('PING :tmi.twitch.tv\r\n');
    expect(states).not.toContain('connected');
    a.receive(':tmi.twitch.tv RECONNECT\r\n');
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.sockets).toHaveLength(2);
    expect(states).toContain('reconnecting');
    const b = FakeWebSocket.sockets[1]!;
    b.open();
    b.receive(connected);
    expect(states.at(-1)).toBe('connected');
  });

  it('reports synchronous socket-construction failures and retries without throwing from timer callbacks', async () => {
    let attempts = 0;
    class FailFirstSocket extends FakeWebSocket {
      constructor(url: string) {
        if (++attempts === 1) throw new Error('WebSocket blocked by runtime');
        super(url);
      }
    }
    vi.stubGlobal('WebSocket', FailFirstSocket);
    const connection = start();
    expect(connection.channel).toBe('host');
    expect(errors.at(-1)?.message).toMatch(/blocked by runtime/);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.sockets).toHaveLength(1);
    FakeWebSocket.sockets[0]!.open();
    FakeWebSocket.sockets[0]!.receive(connected);
    expect(states.at(-1)).toBe('connected');
  });

  it('cleans up timers and suppresses stale callbacks and reconnects after close', async () => {
    const controller = new AbortController();
    start({ signal: controller.signal });
    const a = FakeWebSocket.sockets[0]!;
    a.open();
    controller.abort();
    a.receive(privmsg() + '\r\n');
    a.drop();
    await vi.advanceTimersByTimeAsync(30000);
    expect(events).toHaveLength(0);
    expect(FakeWebSocket.sockets).toHaveLength(1);
    expect(a.closeCount).toBeGreaterThan(0);
  });

  it('rejects malformed channel/nick and bounded runaway frames without dispatch', () => {
    expect(() => start({ channel: 'host\r\nPRIVMSG #a' })).toThrow();
    expect(() => start({ nickname: 'bad nick' })).toThrow();
    start();
    const socket = FakeWebSocket.sockets[0]!;
    socket.open();
    socket.receive('x'.repeat(140000));
    expect(events).toHaveLength(0);
    expect(errors.at(-1)?.message).toMatch(/limit|size|large/i);
  });
});
