import type { KickSocketHandle, KickSocketOptions } from './types';

const DEFAULT_BASE_URL = 'wss://ws-us2.pusher.com/app';
const DEFAULT_APP_KEY = '32cbd69e4b950bf97679';
const DEFAULT_INACTIVITY_TIMEOUT_MS = 90_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export function kickReconnectDelay(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
  const jittered = base * (0.75 + Math.random() * 0.5);
  return Math.round(Math.min(jittered, MAX_RECONNECT_DELAY_MS));
}

const socketUrl = (appKey: string, baseUrl: string): string => {
  const params = new URLSearchParams({
    protocol: '7',
    client: 'js',
    version: '8.4.0',
    flash: 'false',
  });
  return `${baseUrl.replace(/\/$/u, '')}/${appKey}?${params.toString()}`;
};

const parseActivityTimeoutMs = (data: unknown): number | null => {
  let payload: unknown = data;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const seconds = (payload as { activity_timeout?: unknown }).activity_timeout;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : null;
};

export function createKickSocket(
  chatroomId: number,
  options: KickSocketOptions = {},
): KickSocketHandle {
  if (!Number.isInteger(chatroomId) || chatroomId <= 0) {
    throw new Error('Kick chatroom id must be a positive integer');
  }

  const appKey = options.appKey ?? DEFAULT_APP_KEY;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const configuredInactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
  const desiredChannels = [...new Set([
    `chatrooms.${chatroomId}.v2`,
    ...(options.channelId?.trim() ? [`channel.${options.channelId.trim()}`] : []),
    ...(options.additionalChannels ?? []).map((channel) => channel.trim()).filter(Boolean),
  ])];

  let socket: WebSocket | null = null;
  let stopped = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let lastActivityAt = Date.now();
  let negotiatedActivityTimeoutMs: number | null = null;
  let stableConnection = false;
  let pendingSubscriptions = new Set<string>();

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    clearReconnectTimer();
    options.onStateChange?.('reconnecting');
    const delay = kickReconnectDelay(reconnectAttempts++);
    reconnectTimer = setTimeout(connect, delay);
  };

  const markStableConnection = (current: WebSocket) => {
    if (stopped || socket !== current || stableConnection) return;
    stableConnection = true;
    reconnectAttempts = 0;
    options.onStateChange?.('connected');
    options.onOpen?.();
  };

  const handleMessage = (current: WebSocket, event: MessageEvent<unknown>) => {
    if (stopped || socket !== current) return;
    lastActivityAt = Date.now();
    if (typeof event.data !== 'string') return;

    let envelope: { event?: unknown; data?: unknown } | null = null;
    try {
      const parsed = JSON.parse(event.data) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        envelope = parsed as { event?: unknown; data?: unknown };
      }
    } catch {
      // Application frames are passed through to the normal parser below.
    }

    if (envelope && typeof envelope.event === 'string') {
      if (envelope.event === 'pusher:connection_established') {
        negotiatedActivityTimeoutMs = parseActivityTimeoutMs(envelope.data);
        pendingSubscriptions = new Set(desiredChannels);
        for (const channel of desiredChannels) {
          current.send(JSON.stringify({
            event: 'pusher:subscribe',
            data: { auth: '', channel },
          }));
        }
        return;
      }

      if (envelope.event === 'pusher:ping') {
        current.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
        return;
      }

      if (envelope.event === 'pusher:pong') return;

      if (envelope.event === 'pusher_internal:subscription_succeeded') {
        const channel = typeof (envelope as { channel?: unknown }).channel === 'string'
          ? (envelope as { channel: string }).channel
          : undefined;
        if (channel) pendingSubscriptions.delete(channel);
        if (pendingSubscriptions.size === 0) markStableConnection(current);
        return;
      }

      if (envelope.event.startsWith('pusher:') || envelope.event.startsWith('pusher_internal:')) {
        return;
      }
    }

    // Application events can arrive while another requested Pusher channel is still
    // confirming. Process them, but do not claim the whole connector is ready until
    // every desired subscription has succeeded.
    if (pendingSubscriptions.size === 0) markStableConnection(current);
    options.onMessage?.(event.data);
  };

  function connect() {
    if (stopped) return;
    options.onStateChange?.(reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
    lastActivityAt = Date.now();
    negotiatedActivityTimeoutMs = null;
    stableConnection = false;
    pendingSubscriptions = new Set();

    const next = new WebSocket(socketUrl(appKey, baseUrl));
    socket = next;

    next.onopen = () => {
      if (stopped || socket !== next) return;
      lastActivityAt = Date.now();
      // Pusher readiness is established by pusher:connection_established and the
      // channel subscription, not merely by the WebSocket HTTP upgrade succeeding.
    };

    next.onmessage = (event) => handleMessage(next, event);

    next.onerror = () => {
      if (stopped || socket !== next) return;
      options.onStateChange?.('error');
      options.onError?.(new Error('Kick WebSocket error'));
    };

    next.onclose = () => {
      if (socket === next) socket = null;
      options.onClose?.();
      if (stopped) {
        options.onStateChange?.('disconnected');
        return;
      }
      scheduleReconnect();
    };
  }

  watchdogTimer = setInterval(() => {
    if (stopped || !socket) return;
    // Pusher advertises activity_timeout in seconds. Never make our watchdog
    // stricter than the negotiated interval, and leave one polling interval of
    // grace so its own ping can arrive before we declare the connection stale.
    const negotiatedFloor = negotiatedActivityTimeoutMs === null
      ? 0
      : negotiatedActivityTimeoutMs + WATCHDOG_INTERVAL_MS;
    const inactivityTimeoutMs = Math.max(configuredInactivityTimeoutMs, negotiatedFloor);
    if (Date.now() - lastActivityAt <= inactivityTimeoutMs) return;
    options.onError?.(new Error(`No Kick chat activity for ${inactivityTimeoutMs}ms; reconnecting`));
    socket.close();
  }, Math.min(
    WATCHDOG_INTERVAL_MS,
    Math.max(Math.floor(configuredInactivityTimeoutMs / 3), 1),
  ));

  connect();

  return {
    close: () => {
      if (stopped) return;
      stopped = true;
      clearReconnectTimer();
      if (watchdogTimer !== null) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      const current = socket;
      socket = null;
      if (current) {
        current.onopen = null;
        current.onmessage = null;
        current.onerror = null;
        current.onclose = null;
        current.close();
      }
      options.onStateChange?.('disconnected');
    },
  };
}
