import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { createChatBus, type ChatBusConnectionSpec } from '../bus';
import type { ChatConnectionState, ChatEvent } from '../types/chat';
import {
  parseRelayCommand,
  RELAY_PROTOCOL_VERSION,
  type RelayConnectRequest,
  type RelayServerPacket,
} from './protocol';

interface RelayCallbacks {
  onEvent(event: ChatEvent): void;
  onStateChange(state: ChatConnectionState): void;
  onError(error: Error): void;
}
interface RelayConnection { close(): void; }
type RelayConnector = (spec: ChatBusConnectionSpec, callbacks: RelayCallbacks) => Promise<RelayConnection>;

export interface ChatbusRelayServerOptions {
  server: HttpServer;
  path?: string;
  authorizeUpgrade?: (request: IncomingMessage) => boolean;
  resolveConnection(request: RelayConnectRequest): ChatBusConnectionSpec | Promise<ChatBusConnectionSpec>;
  /** Test/host seam. Normal callers should let the relay use createChatBus(). */
  connect?: RelayConnector;
}

export interface ChatbusRelayServer { close(): void; }

const send = (ws: WebSocket, packet: RelayServerPacket) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(packet));
};
const sameOrigin = (req: IncomingMessage): boolean => {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host === host;
  } catch { return false; }
};
const rejectUpgrade = (socket: Duplex, status = 403) => {
  socket.write(`HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
};
const defaultConnect: RelayConnector = async (spec, callbacks) => {
  const bus = createChatBus({
    onEvent: callbacks.onEvent,
    onConnectionStateChange: state => callbacks.onStateChange(state.state),
    onError: error => callbacks.onError(error),
  });
  try {
    const handle = await bus.connect(spec);
    return { close: () => { handle.close(); bus.close(); } };
  } catch (error) {
    bus.close();
    throw error;
  }
};

export function attachChatbusRelayServer(options: ChatbusRelayServerOptions): ChatbusRelayServer {
  const relayPath = options.path ?? '/api/chatbus/live';
  const connector = options.connect ?? defaultConnect;
  const wss = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: 16 * 1024 });
  const sessions = new Map<WebSocket, () => void>();
  let stopped = false;

  wss.on('connection', ws => {
    send(ws, { type: 'ready', protocol: RELAY_PROTOCOL_VERSION });
    let connection: RelayConnection | undefined;
    let connecting = false;
    let closed = false;
    const dispose = () => {
      if (closed) return;
      closed = true;
      sessions.delete(ws);
      const handle = connection;
      connection = undefined;
      handle?.close();
    };
    sessions.set(ws, dispose);
    const isCurrent = () => !closed && !stopped && ws.readyState === WebSocket.OPEN;
    const emit = (packet: RelayServerPacket) => { if (isCurrent()) send(ws, packet); };
    ws.on('message', async raw => {
      if (!isCurrent()) return;
      if (connection || connecting) { send(ws, { type: 'error', message: 'Relay socket already has a connection' }); return; }
      connecting = true;
      try {
        const command = parseRelayCommand(String(raw));
        const spec = await options.resolveConnection({ platform: command.platform, target: command.target });
        if (!isCurrent()) return;
        const handle = await connector(spec, {
          onEvent: event => emit({ type: 'event', event }),
          onStateChange: state => emit({ type: 'state', state }),
          onError: error => emit({ type: 'error', message: error.message }),
        });
        if (!isCurrent()) { handle.close(); return; }
        connection = handle;
      } catch (error) {
        emit({ type: 'error', message: error instanceof Error ? error.message : 'Chatbus relay connection failed' });
      } finally { connecting = false; }
    });
    ws.on('close', dispose);
    ws.on('error', () => { dispose(); ws.terminate(); });
  });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== relayPath) return;
    if (!sameOrigin(req) || (options.authorizeUpgrade && !options.authorizeUpgrade(req))) { rejectUpgrade(socket); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  };
  options.server.on('upgrade', onUpgrade);

  return {
    close() {
      if (stopped) return;
      stopped = true;
      options.server.off('upgrade', onUpgrade);
      for (const [socket, dispose] of sessions) { dispose(); socket.terminate(); }
      wss.close();
    },
  };
}

/** Shared settings for the local anonymous Kick relay. Presentation apps choose
 * whether historical messages should seed their view or only receive live chat. */
export function resolveLocalKickRelayConnection(request: RelayConnectRequest, history: boolean): ChatBusConnectionSpec {
  if (request.platform !== 'kick') throw new Error('Platform not enabled on the local Kick relay');
  const channel = request.target.trim();
  if (!/^[a-z0-9_-]{1,100}$/i.test(channel)) throw new Error('Invalid Kick relay target');
  return { platform: 'kick', options: {
    channel, emitInitialHistory: history, ...(history ? { initialHistoryLimit: 20 } : {}),
  } };
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  if (!request.headers.host) return false;
  try {
    const url = new URL('http://' + request.headers.host);
    return !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

export interface LocalKickRelayOptions {
  server: HttpServer;
  emitInitialHistory: boolean;
  connect?: RelayConnector;
}

/** Mount on an existing local HTTP server. No additional service or port.
 * Reverse proxies must not forward the local control routes publicly. */
export function attachLocalKickRelay(options: LocalKickRelayOptions) {
  const relay = attachChatbusRelayServer({
    server: options.server,
    authorizeUpgrade: isLoopbackRequest,
    resolveConnection: request => resolveLocalKickRelayConnection(request, options.emitInitialHistory),
    connect: options.connect,
  });
  let closed = false;
  return {
    handleStatus(request: IncomingMessage, response: ServerResponse): boolean {
      if (request.url?.split('?')[0] !== '/api/chatbus/status') return false;
      const available = !closed && isLoopbackRequest(request);
      const status = !available ? 404 : request.method !== 'GET' ? 405 : 200;
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(JSON.stringify(status === 200
        ? { available: true, mode: 'local', protocol: RELAY_PROTOCOL_VERSION, platforms: ['kick'] }
        : { available: false }));
      return true;
    },
    close() { if (!closed) { closed = true; relay.close(); } },
  };
}

export {createKickWebhookReceiver,fetchKickWebhookPublicKey} from '../platforms/kick/webhook';
export type {KickWebhookOptions,KickWebhookSubscription,KickWebhookResult} from '../platforms/kick/webhook';
