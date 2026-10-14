import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectStreamlabs, streamlabsWebSocketUrl } from '../src/platforms/streamlabs/connect';

class SocketFixture {
  readyState = 0;
  sent: string[] = [];
  closes = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  frame(data: string): void { this.onmessage?.({ data } as MessageEvent); }
  send(data: string): void { this.sent.push(data); }
  close(): void {
    this.closes++;
    this.readyState = 3;
    this.onclose?.(new Event('close') as CloseEvent);
  }
  error(): void { this.onerror?.(new Event('error')); }
}

const handshake = (interval = 100, timeout = 50) =>
  `0${JSON.stringify({ sid: 'fixture-sid', upgrades: [], pingInterval: interval, pingTimeout: timeout })}`;
const follow = (id: string) =>
  `42${JSON.stringify(['event', [{ type: 'follow', for: 'twitch_account',
    message: [{ name: 'tester', _id: id }] }]])}`;

describe('WebSocket-only Streamlabs Socket.IO v2 transport', () => {
  let sockets: SocketFixture[];
  let urls: string[];
  const factory = (url: string): WebSocket => {
    urls.push(url);
    const socket = new SocketFixture();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    urls = [];
  });
  afterEach(() => vi.useRealTimers());

  it('constructs Engine.IO v3 WebSocket URLs with encoded token and rejects insecure remote transports', () => {
    const url = new URL(streamlabsWebSocketUrl('https://sockets.streamlabs.com/', 'tok+/=&'));
    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/socket.io/');
    expect(url.searchParams.get('EIO')).toBe('3');
    expect(url.searchParams.get('transport')).toBe('websocket');
    expect(url.searchParams.get('token')).toBe('tok+/=&');
    expect(() => streamlabsWebSocketUrl('http://example.com', 'token')).toThrow('secure');
    expect(() => streamlabsWebSocketUrl('http://example.com@evil.net', 'token')).toThrow();
    expect(streamlabsWebSocketUrl('http://localhost:5000', 'test')).toMatch(/^ws:\/\/localhost:5000\/socket.io\//);
  });

  it('requires Engine.IO open then Socket.IO namespace connect before reporting ready', () => {
    const states: string[] = [];
    const events = vi.fn();
    const conn = connectStreamlabs({ token: 'private', onEvent: events,
      onStateChange: state => states.push(state), webSocketFactory: factory });
    const ws = sockets[0];
    expect(states).toEqual(['connecting']);
    ws.open();
    expect(conn.state()).toBe('connecting');
    ws.frame(follow('before-connect'));
    expect(events).not.toHaveBeenCalled();
    ws.frame(handshake());
    expect(conn.state()).toBe('connecting');
    ws.frame('40');
    expect(states).toEqual(['connecting', 'connected']);
    ws.frame(follow('a'));
    ws.frame(follow('a'));
    ws.frame(follow('b'));
    expect(events).toHaveBeenCalledTimes(2);
    expect(events.mock.calls[0][0].id).toBe('streamlabs:twitch_account:follow:a');
    conn.close();
    ws.frame(follow('c'));
    expect(events).toHaveBeenCalledTimes(2);
    expect(conn.state()).toBe('disconnected');
    expect(ws.closes).toBe(1);
  });

  it('sends Engine.IO v3 client pings and enforces pong timeout', () => {
    const states: string[] = [];
    const onError = vi.fn();
    const conn = connectStreamlabs({ token: 'secret', webSocketFactory: factory,
      onEvent: vi.fn(), onError, onStateChange: state => states.push(state) });
    const ws = sockets[0];
    ws.open();
    ws.frame(handshake(100, 50));
    ws.frame('40');
    vi.advanceTimersByTime(100);
    expect(ws.sent).toEqual(['2']);
    ws.frame('3');
    vi.advanceTimersByTime(100);
    expect(ws.sent).toEqual(['2', '2']);
    vi.advanceTimersByTime(50);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Streamlabs heartbeat timed out',
    }));
    expect(conn.state()).toBe('reconnecting');
    expect(ws.closes).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
    expect(urls[0]).toBe(urls[1]);
    conn.close();
  });

  it('reconnects after remote closure while retaining bounded message dedupe', () => {
    const events = vi.fn();
    const states: string[] = [];
    const conn = connectStreamlabs({ token: 'secret', webSocketFactory: factory,
      onEvent: events, dedupeLimit: 2, onStateChange: state => states.push(state) });
    sockets[0].open();
    sockets[0].frame(handshake());
    sockets[0].frame('40');
    sockets[0].frame(follow('id1'));
    sockets[0].close();
    expect(conn.state()).toBe('reconnecting');
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    sockets[1].frame(handshake());
    sockets[1].frame('40');
    sockets[1].frame(follow('id1'));
    sockets[1].frame(follow('id2'));
    sockets[1].frame(follow('id3'));
    sockets[1].frame(follow('id1')); // ID aged out of the last two.
    expect(events).toHaveBeenCalledTimes(4);
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'connected']);
    conn.close();
    vi.runAllTimers();
    expect(sockets).toHaveLength(2);
  });

  it('rejects a malformed handshake without exposing credentials in errors', () => {
    const onError = vi.fn();
    const conn = connectStreamlabs({ token: 'really-secret', webSocketFactory: factory,
      onEvent: vi.fn(), onError });
    sockets[0].open();
    sockets[0].frame('0{"sid":"invalid","pingInterval":-1,"pingTimeout":50}');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).not.toContain('really-secret');
    expect(conn.state()).toBe('reconnecting');
    conn.close();
  });

  it('times out a silent handshake and stops scheduled retry after close', () => {
    const onError = vi.fn();
    const conn = connectStreamlabs({ token: 'test', webSocketFactory: factory,
      onEvent: vi.fn(), onError });
    sockets[0].open();
    vi.advanceTimersByTime(15_000);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Streamlabs handshake timed out',
    }));
    conn.close();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('handles auxiliary and unknown frames without presenting them as follows', () => {
    const onEvent = vi.fn();
    const onAuxiliary = vi.fn();
    const onUnknown = vi.fn();
    const conn = connectStreamlabs({ token: 'test', webSocketFactory: factory,
      onEvent, onAuxiliary, onUnknown });
    sockets[0].open();
    sockets[0].frame(handshake());
    sockets[0].frame('40');
    sockets[0].frame('42["event",[{"type":"alertPlaying","message":{"type":"follow"}}]]');
    sockets[0].frame('42["not-an-event",{}]');
    sockets[0].frame('42["event",oops]');
    expect(onEvent).not.toHaveBeenCalled();
    expect(onAuxiliary).toHaveBeenCalledTimes(1);
    expect(onUnknown).toHaveBeenCalledTimes(2);
    conn.close();
  });

  it('responds to server-initiated ping and does not mistake a transport error for a completed connection', () => {
    const onError = vi.fn();
    const conn = connectStreamlabs({ token: 'test', webSocketFactory: factory,
      onEvent: vi.fn(), onError });
    sockets[0].open();
    sockets[0].frame(handshake());
    sockets[0].frame('2');
    expect(sockets[0].sent).toContain('3');
    sockets[0].error();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Streamlabs WebSocket transport error',
    }));
    expect(conn.state()).toBe('reconnecting');
    conn.close();
  });

  it('reconnects when Engine.IO explicitly closes the session', () => {
    const onError = vi.fn();
    const conn = connectStreamlabs({ token: 'test', webSocketFactory: factory,
      onEvent: vi.fn(), onError });
    sockets[0].open();
    sockets[0].frame(handshake());
    sockets[0].frame('40');
    sockets[0].frame('1');
    expect(conn.state()).toBe('reconnecting');
    expect(onError.mock.calls[0][0].message).toBe('Streamlabs Engine.IO session closed');
    conn.close();
  });

  it('stops delivering a batch immediately when the consumer closes the connection', () => {
    const events = vi.fn();
    let conn: ReturnType<typeof connectStreamlabs>;
    conn = connectStreamlabs({ token: 'test', webSocketFactory: factory,
      onEvent: event => { events(event); conn.close(); } });
    sockets[0].open();
    sockets[0].frame(handshake());
    sockets[0].frame('40');
    sockets[0].frame('42["event",[{"type":"follow","message":[{"_id":"one","name":"One"},{"_id":"two","name":"Two"}]}]]');
    expect(events).toHaveBeenCalledTimes(1);
    expect(conn.state()).toBe('disconnected');
  });
});
