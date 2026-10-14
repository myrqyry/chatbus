import type { ChatConnectionState, ChatEvent } from '../../types/chat';
import {
  normalizeStreamlabsPayload,
  type StreamlabsAuxiliaryEvent,
  type StreamlabsUnknownEvent,
} from './normalize';

export interface StreamlabsConnectOptions {
  token: string;
  onEvent: (event: ChatEvent) => void;
  onAuxiliary?: (event: StreamlabsAuxiliaryEvent) => void;
  onUnknown?: (event: StreamlabsUnknownEvent) => void;
  onStateChange?: (state: ChatConnectionState) => void;
  onError?: (error: Error) => void;
  channelName?: string;
  url?: string;
  dedupeLimit?: number;
  /** Override only for local integration testing or a trusted custom WebSocket implementation. */
  webSocketFactory?: (url: string) => WebSocket;
}

export interface StreamlabsConnection {
  close: () => void;
  state: () => ChatConnectionState;
}

const HANDSHAKE_TIMEOUT_MS = 15_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const MAX_PACKET_LENGTH = 2 * 1024 * 1024;
const WS_OPEN = 1; // WebSocket.OPEN; also works with injected factories on older Node.

interface EngineHandshake {
  sid: string;
  pingInterval: number;
  pingTimeout: number;
}

const isHandshake = (value: unknown): value is EngineHandshake => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return typeof data.sid === 'string' && data.sid.length > 0 &&
    typeof data.pingInterval === 'number' && Number.isSafeInteger(data.pingInterval) &&
    data.pingInterval > 0 && data.pingInterval <= 600_000 &&
    typeof data.pingTimeout === 'number' && Number.isSafeInteger(data.pingTimeout) &&
    data.pingTimeout > 0 && data.pingTimeout <= 600_000;
};

/** Streamlabs uses Socket.IO v2 / Engine.IO v3, even on its WebSocket transport. */
export function streamlabsWebSocketUrl(origin: string, token: string): string {
  const base = new URL(origin);
  if (base.username || base.password || base.hash) {
    throw new Error('Streamlabs URL cannot contain credentials or fragments');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && base.protocol !== 'wss:' &&
      !(loopback && (base.protocol === 'http:' || base.protocol === 'ws:'))) {
    throw new Error('Streamlabs requires a secure WebSocket endpoint (except loopback)');
  }
  const target = new URL('/socket.io/', base);
  target.protocol = base.protocol === 'https:' ? 'wss:' :
    base.protocol === 'http:' ? 'ws:' : base.protocol;
  target.searchParams.set('EIO', '3');
  target.searchParams.set('transport', 'websocket');
  target.searchParams.set('token', token);
  return target.href;
}

/**
 * Minimal read-only Socket.IO v2 transport using the host's WebSocket API.
 * This deliberately does not implement arbitrary Socket.IO namespaces, binary
 * attachments, client emits, polling, or upgrade negotiation.
 */
export function connectStreamlabs(options: StreamlabsConnectOptions): StreamlabsConnection {
  const token = options.token.trim();
  if (!token) throw new Error('Streamlabs socket token must not be empty');
  const limit = options.dedupeLimit ?? 1024;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('dedupeLimit must be a positive safe integer');
  }
  const url = streamlabsWebSocketUrl(options.url ?? 'https://sockets.streamlabs.com', token);
  const makeSocket = options.webSocketFactory ?? ((address: string) => new WebSocket(address));

  const seen = new Set<string>();
  const order: string[] = [];
  let closed = false;
  let current: ChatConnectionState = 'connecting';
  let socket: WebSocket | undefined;
  let generation = 0;
  let retries = 0;
  let handshake: EngineHandshake | undefined;
  let awaitingPong = false;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setTimeout> | undefined;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const transition = (next: ChatConnectionState): void => {
    if (closed || current === next) return;
    current = next;
    options.onStateChange?.(next);
  };
  const clearSessionTimers = (): void => {
    clearTimeout(handshakeTimer);
    clearTimeout(pingTimer);
    clearTimeout(pongTimer);
    handshakeTimer = pingTimer = pongTimer = undefined;
    awaitingPong = false;
  };
  const remember = (id: string | undefined): boolean => {
    if (!id) return true; // No stable ID: never invent deduplication certainty.
    if (seen.has(id)) return false;
    seen.add(id);
    order.push(id);
    if (order.length > limit) seen.delete(order.shift()!);
    return true;
  };
  const reportError = (detail: string): void => {
    options.onError?.(new Error(detail)); // No token or socket URL in errors.
  };

  const scheduleRetry = (): void => {
    if (closed || reconnectTimer) return;
    clearSessionTimers();
    handshake = undefined;
    transition('reconnecting');
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(retries, 5)));
    retries += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      openSocket();
    }, delay);
  };

  const failSocket = (ws: WebSocket, message: string): void => {
    if (closed || socket !== ws) return;
    reportError(message);
    transition('error');
    ws.close();
    // A broken WebSocket may never produce a close event; don't wait for it.
    socket = undefined;
    scheduleRetry();
  };

  const schedulePing = (ws: WebSocket): void => {
    clearTimeout(pingTimer);
    if (!handshake || closed || socket !== ws) return;
    pingTimer = setTimeout(() => {
      if (closed || socket !== ws || ws.readyState !== WS_OPEN || !handshake) return;
      awaitingPong = true;
      ws.send('2'); // Engine.IO v3 client-initiated heartbeat.
      pongTimer = setTimeout(() => failSocket(ws, 'Streamlabs heartbeat timed out'),
        handshake.pingTimeout);
    }, handshake.pingInterval);
  };

  function openSocket(): void {
    if (closed) return;
    const epoch = ++generation;
    let ws: WebSocket;
    try {
      ws = makeSocket(url);
    } catch {
      reportError('Streamlabs WebSocket could not be created');
      transition('error');
      scheduleRetry();
      return;
    }
    socket = ws;
    handshake = undefined;
    clearSessionTimers();
    const live = (): boolean => !closed && socket === ws && generation === epoch;
    handshakeTimer = setTimeout(() => {
      if (live() && current !== 'connected') {
        failSocket(ws, 'Streamlabs handshake timed out');
      }
    }, HANDSHAKE_TIMEOUT_MS);

    ws.onopen = () => { /* Socket.IO namespace acknowledgement, not TCP open, determines readiness. */ };
    ws.onmessage = (message: MessageEvent) => {
      if (!live()) return;
      const frame = message.data;
      if (typeof frame !== 'string' || frame.length > MAX_PACKET_LENGTH) {
        failSocket(ws, 'Streamlabs sent an unsupported or oversized frame');
        return;
      }
      if (frame.startsWith('0')) {
        if (handshake) {
          failSocket(ws, 'Streamlabs sent a duplicate Engine.IO handshake');
          return;
        }
        try {
          const data: unknown = JSON.parse(frame.slice(1));
          if (!isHandshake(data)) throw new Error('invalid handshake');
          handshake = data;
          schedulePing(ws);
        } catch {
          failSocket(ws, 'Streamlabs sent an invalid Engine.IO handshake');
        }
        return;
      }
      if (frame === '3' && awaitingPong) {
        awaitingPong = false;
        clearTimeout(pongTimer);
        pongTimer = undefined;
        schedulePing(ws);
        return;
      }
      if (frame === '2') {
        ws.send('3'); // Defensive compatibility with server-initiated heartbeat.
        return;
      }
      if (frame === '1') {
        failSocket(ws, 'Streamlabs Engine.IO session closed');
        return;
      }
      if (frame === '40') {
        if (!handshake) {
          failSocket(ws, 'Streamlabs connected before Engine.IO handshake');
          return;
        }
        clearTimeout(handshakeTimer);
        handshakeTimer = undefined;
        retries = 0;
        transition('connected');
        return;
      }
      if (frame === '41' || frame.startsWith('44')) {
        failSocket(ws, 'Streamlabs Socket.IO namespace disconnected');
        return;
      }
      if (!frame.startsWith('42') || current !== 'connected') return;
      let packet: unknown;
      try { packet = JSON.parse(frame.slice(2)); }
      catch {
        options.onUnknown?.({ reason: 'invalid-envelope', raw: frame });
        return;
      }
      if (!Array.isArray(packet) || packet[0] !== 'event' || packet.length < 2) {
        options.onUnknown?.({ reason: 'unsupported-type', raw: packet });
        return;
      }
      const parsed = normalizeStreamlabsPayload(packet[1], { channelName: options.channelName });
      for (const event of parsed.events) {
        if (closed) return;
        if (remember(event.id)) options.onEvent(event);
      }
      for (const event of parsed.auxiliary) {
        if (closed) return;
        options.onAuxiliary?.(event);
      }
      for (const event of parsed.unknown) {
        if (closed) return;
        options.onUnknown?.(event);
      }
    };
    ws.onerror = () => {
      if (live()) failSocket(ws, 'Streamlabs WebSocket transport error');
    };
    ws.onclose = () => {
      if (!live()) return;
      socket = undefined;
      scheduleRetry();
    };
  }

  options.onStateChange?.('connecting');
  openSocket();
  return {
    state: () => current,
    close: () => {
      if (closed) return;
      closed = true;
      generation++;
      clearSessionTimers();
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      socket?.close();
      socket = undefined;
      current = 'disconnected';
      seen.clear();
      order.length = 0;
      options.onStateChange?.('disconnected');
    },
  };
}
