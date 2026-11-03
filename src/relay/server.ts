import type { IncomingMessage, Server as HttpServer } from 'node:http';
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
  const active = new Set<RelayConnection>();

  wss.on('connection', ws => {
    send(ws, { type: 'ready', protocol: RELAY_PROTOCOL_VERSION });
    let connection: RelayConnection | undefined;
    let connecting = false;
    ws.on('message', async raw => {
      if (connection || connecting) { send(ws, { type: 'error', message: 'Relay socket already has a connection' }); return; }
      connecting = true;
      try {
        const command = parseRelayCommand(String(raw));
        const spec = await options.resolveConnection({ platform: command.platform, target: command.target });
        connection = await connector(spec, {
          onEvent: event => send(ws, { type: 'event', event }),
          onStateChange: state => send(ws, { type: 'state', state }),
          onError: error => send(ws, { type: 'error', message: error.message }),
        });
        active.add(connection);
      } catch (error) {
        send(ws, { type: 'error', message: error instanceof Error ? error.message : 'Chatbus relay connection failed' });
      } finally { connecting = false; }
    });
    ws.on('close', () => {
      if (!connection) return;
      connection.close();
      active.delete(connection);
    });
  });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== relayPath) return;
    if (!sameOrigin(req)) { rejectUpgrade(socket); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  };
  options.server.on('upgrade', onUpgrade);

  return {
    close() {
      options.server.off('upgrade', onUpgrade);
      for (const connection of active) connection.close();
      active.clear();
      wss.close();
    },
  };
}
