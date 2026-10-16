import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectTwitchChat, type TwitchChatConnection, type TwitchSubscriptionStateChange } from '../src/index';

type Subscription = { id: string; type: string; status: string; version: string;
  condition: { broadcaster_user_id: string }; transport: { method: string; session_id: string } };
const record = (type: string, sessionId = 'session-1', broadcaster = '10'): Subscription => ({
  id: 'sub-' + type, type, version: '1', status: 'enabled',
  condition: { broadcaster_user_id: broadcaster },
  transport: { method: 'websocket', session_id: sessionId },
});

class TestSocket {
  static instances: TestSocket[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closeCount = 0;
  constructor(readonly url: string) { TestSocket.instances.push(this); }
  close() { this.closeCount++; }
  emit(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent<string>);
  }
}
const welcome = (id: string) => ({
  metadata: { message_id: 'welcome-' + id, message_type: 'session_welcome', message_timestamp: '2026-10-16T12:00:00Z' },
  payload: { session: { id, status: 'connected', keepalive_timeout_seconds: 3600 } },
});
const revoke = (type: string) => ({
  metadata: { message_id: 'revoke-' + type, message_type: 'revocation',
    message_timestamp: '2026-10-16T12:01:00Z', subscription_type: type, subscription_version: '1' },
  payload: { subscription: { id: 'sub-' + type, type, version: '1', status: 'notification_failures_exceeded' } },
});
const selected = ['channel.chat.message', 'channel.chat.notification'] as const;
const tick = async () => { await vi.advanceTimersByTimeAsync(10_000); };

describe('Twitch EventSub subscription reconciliation', () => {
  const connections: TwitchChatConnection[] = [];
  let stored: Subscription[];
  let posts: string[];
  let gets: URL[];
  let errors: Error[];
  let changes: TwitchSubscriptionStateChange[];
  let inspect: (url: URL) => Response | Promise<Response>;
  let onPost: (type: string) => Response | Promise<Response>;

  beforeEach(() => {
    vi.useFakeTimers();
    TestSocket.instances = [];
    stored = selected.map((s) => record(s));
    posts = [];
    gets = [];
    errors = [];
    changes = [];
    inspect = () => new Response(JSON.stringify({ data: stored, pagination: {} }), { status: 200 });
    onPost = (type) => new Response(JSON.stringify({ data: [record(type)] }), { status: 202 });
    vi.stubGlobal('WebSocket', TestSocket);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'id.twitch.tv') return new Response(JSON.stringify({
        client_id: 'client-1', user_id: 'user-1', login: 'bot', scopes: ['user:read:chat'],
      }), { status: 200 });
      if (url.pathname === '/helix/users') return new Response(JSON.stringify({
        data: [{ id: '10', login: 'host', display_name: 'Host' }],
      }), { status: 200 });
      if (url.pathname === '/helix/eventsub/subscriptions' && init?.method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { type: string };
        posts.push(body.type);
        return onPost(body.type);
      }
      if (url.pathname === '/helix/eventsub/subscriptions') {
        gets.push(url);
        return inspect(url);
      }
      throw new Error('Unexpected request: ' + url.toString());
    }));
  });
  afterEach(() => {
    for (const c of connections) c.close();
    connections.length = 0;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const start = async () => {
    const connection = await connectTwitchChat({
      channel: 'host', accessToken: 'token', loadCheermotes: false,
      subscriptions: [...selected], subscriptionReconcileIntervalMs: 10_000,
      onEvent: () => {},
      onError: (error) => errors.push(error),
      onSubscriptionStateChange: (change) => changes.push(change),
    });
    connections.push(connection);
    TestSocket.instances[0]!.emit(welcome('session-1'));
    await vi.advanceTimersByTimeAsync(0);
    return connection;
  };

  it('checks the authoritative active session and recreates a silently missing type while the socket stays healthy', async () => {
    const connection = await start();
    expect(connection.subscriptions().map((s) => s.type)).toEqual([...selected]);
    expect(posts).toEqual([...selected]);
    stored = [record('channel.chat.message'), record('channel.chat.notification', 'other-session')];
    await tick();
    expect(gets).toHaveLength(1);
    expect(gets[0]?.searchParams.get('status')).toBe('enabled');
    expect(posts).toEqual([...selected, 'channel.chat.notification']);
    expect(changes.at(-1)).toMatchObject({ reason: 'repaired', subscriptions: [
      expect.objectContaining({ type: 'channel.chat.message' }),
      expect.objectContaining({ type: 'channel.chat.notification' }),
    ] });
    expect(TestSocket.instances[0]?.closeCount).toBe(0);
  });

  it('does not mistake later pages for missing subscriptions, or re-create healthy ones', async () => {
    await start();
    inspect = (url) => new Response(JSON.stringify(
      url.searchParams.has('after')
        ? { data: [record('channel.chat.notification')], pagination: {} }
        : { data: [record('channel.chat.message')], pagination: { cursor: 'next' } },
    ), { status: 200 });
    await tick();
    expect(gets.map((v) => v.searchParams.get('after'))).toEqual([null, 'next']);
    expect(posts).toEqual([...selected]);
    expect(changes).toHaveLength(1);
  });

  it('keeps last known subscription state and does not create duplicates after an API error', async () => {
    const connection = await start();
    inspect = () => new Response(JSON.stringify({ message: 'rate limited' }), { status: 429 });
    await tick();
    expect(connection.subscriptions()).toHaveLength(2);
    expect(posts).toEqual([...selected]);
    expect(errors.at(-1)?.message).toMatch(/429/);
    expect(changes).toHaveLength(1);
    stored = [record('channel.chat.message')];
    inspect = () => new Response(JSON.stringify({ data: stored, pagination: {} }), { status: 200 });
    await tick();
    expect(posts.at(-1)).toBe('channel.chat.notification');
  });

  it('recovers a revoked companion subscription but does not claim success when POST fails', async () => {
    const connection = await start();
    TestSocket.instances[0]!.emit(revoke('channel.chat.notification'));
    expect(connection.subscriptions().map((s) => s.type)).toEqual(['channel.chat.message']);
    stored = [record('channel.chat.message')];
    onPost = () => new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 });
    await tick();
    expect(connection.subscriptions().map((s) => s.type)).toEqual(['channel.chat.message']);
    expect(errors.at(-1)?.message).toMatch(/403/);
    onPost = (type) => new Response(JSON.stringify({ data: [record(type)] }), { status: 202 });
    await tick();
    expect(connection.subscriptions()).toHaveLength(2);
    expect(changes.at(-1)?.reason).toBe('repaired');
  });

  it('uses the transferred session ID after a Twitch server-directed reconnect', async () => {
    const connection = await start();
    const first = TestSocket.instances[0]!;
    first.emit({
      metadata: { message_id: 'handoff', message_type: 'session_reconnect', message_timestamp: '2026-10-16T12:02:00Z' },
      payload: { session: { id: 'session-1', reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?reconnect=abc' } },
    });
    expect(TestSocket.instances).toHaveLength(2);
    TestSocket.instances[1]!.emit(welcome('session-2'));
    await vi.advanceTimersByTimeAsync(0);
    stored = selected.map((s) => record(s, 'session-2'));
    await tick();
    expect(posts).toEqual([...selected]);
    expect(gets).toHaveLength(1);
    expect(connection.subscriptions()).toHaveLength(2);
    expect(first.closeCount).toBe(1);
  });

  it('never repairs after close or when a stale in-flight inspection resolves', async () => {
    const connection = await start();
    let release: ((response: Response) => void) | undefined;
    inspect = () => new Promise<Response>((resolve) => { release = resolve; });
    await tick();
    expect(gets).toHaveLength(1);
    connection.close();
    release?.(new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(gets).toHaveLength(1);
    expect(posts).toEqual([...selected]);
  });

  it('never treats a malformed or incomplete paginated response as proof of missing subscriptions', async () => {
    const connection = await start();
    inspect = () => new Response(JSON.stringify({ data: [{ type: 'channel.chat.message' }], pagination: {} }), { status: 200 });
    await tick();
    expect(posts).toEqual([...selected]);
    expect(connection.subscriptions()).toHaveLength(2);
    expect(errors.at(-1)?.message).toMatch(/malformed/);
    inspect = () => new Response(JSON.stringify({
      data: [record('channel.chat.message')], pagination: { cursor: 'incomplete' },
    }), { status: 200 });
    await tick();
    expect(posts).toEqual([...selected]);
    expect(connection.subscriptions()).toHaveLength(2);
    expect(errors.at(-1)?.message).toMatch(/cursor|pagination/);
  });

  it('refuses to mark an empty POST response as successfully repaired', async () => {
    const connection = await start();
    stored = [record('channel.chat.message')];
    onPost = () => new Response(JSON.stringify({ data: [] }), { status: 202 });
    await tick();
    expect(connection.subscriptions().map((s) => s.type)).toEqual(['channel.chat.message']);
    expect(changes.at(-1)?.reason).toBe('degraded');
    expect(errors.at(-1)?.message).toMatch(/did not confirm/);
  });

  it('does not report successful initial subscriptions after the connection was closed mid-request', async () => {
    const releases: Array<(response: Response) => void> = [];
    onPost = () => new Promise<Response>((resolve) => { releases.push(resolve); });
    const connection = await connectTwitchChat({
      channel: 'host', accessToken: 'token', loadCheermotes: false,
      subscriptions: [...selected], subscriptionReconcileIntervalMs: 10_000,
      onEvent: () => {},
      onError: (error) => errors.push(error),
      onSubscriptionStateChange: (change) => changes.push(change),
    });
    connections.push(connection);
    TestSocket.instances[0]!.emit(welcome('session-1'));
    await Promise.resolve();
    expect(releases).toHaveLength(2);
    connection.close();
    releases.forEach((release, i) =>
      release(new Response(JSON.stringify({ data: [record(selected[i]!)] }), { status: 202 })));
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toHaveLength(0);
    expect(connection.subscriptions()).toEqual([]);
    await tick();
    expect(gets).toHaveLength(0);
  });

  it('refuses to call a zero-subscription connection healthy', async () => {
    onPost = () => new Response(JSON.stringify({ data: [] }), { status: 202 });
    const connection = await connectTwitchChat({
      channel: 'host', accessToken: 'token', loadCheermotes: false,
      subscriptions: [...selected], subscriptionReconcileIntervalMs: 10_000,
      onEvent: () => {},
      onError: (error) => errors.push(error),
      onSubscriptionStateChange: (change) => changes.push(change),
    });
    connections.push(connection);
    TestSocket.instances[0]!.emit(welcome('session-1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(TestSocket.instances[0]!.closeCount).toBeGreaterThan(0);
    expect(errors.at(-1)?.message).toMatch(/no active/i);
    expect(changes).toHaveLength(0);
  });

  it('allows periodic audits to be explicitly disabled', async () => {
    const connection = await connectTwitchChat({
      channel: 'host', accessToken: 'token', loadCheermotes: false,
      subscriptions: [...selected], subscriptionReconcileIntervalMs: 0,
      onEvent: () => {},
      onError: (error) => errors.push(error),
    });
    connections.push(connection);
    TestSocket.instances[0]!.emit(welcome('session-1'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gets).toHaveLength(0);
  });

  it('does not overlap network inspections while an earlier one is pending', async () => {
    await start();
    let release: ((response: Response) => void) | undefined;
    inspect = () => new Promise<Response>((resolve) => { release = resolve; });
    await tick();
    await tick();
    expect(gets).toHaveLength(1);
    release?.(new Response(JSON.stringify({ data: stored, pagination: {} }), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    await tick();
    expect(gets).toHaveLength(2);
  });
});
