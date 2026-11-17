import type { ChatConnectionState, ChatEvent } from '../types/chat';
import {
  RELAY_PROTOCOL_VERSION,
  type RelayPlatform,
  type RelayServerPacket,
} from './protocol';

export interface ChatbusRelayClientOptions {
  platform: RelayPlatform;
  target: string;
  endpoint?: string;
  signal?: AbortSignal;
  onEvent: (event: ChatEvent) => void;
  onStateChange?: (state: ChatConnectionState) => void;
  onError?: (error: Error) => void;
  WebSocketImpl?: typeof WebSocket;
  baseUrl?: string;
}

export interface ChatbusRelayConnection { close(): void; }

const socketUrl = (endpoint: string, baseUrl?: string): string => {
  const base = baseUrl ?? (typeof location !== 'undefined' ? location.href : undefined);
  if (!base) throw new Error('Chatbus relay requires a base URL outside the browser');
  const url = new URL(endpoint, base);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Unsupported relay URL protocol');
  return url.href;
};

export async function connectChatbusRelay(options: ChatbusRelayClientOptions): Promise<ChatbusRelayConnection> {
  const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
  if (options.signal?.aborted) throw abortError();
  const WebSocketCtor = options.WebSocketImpl ?? WebSocket;
  const ws = new WebSocketCtor(socketUrl(options.endpoint ?? '/api/chatbus/live', options.baseUrl));
  let closed = false;
  let sawDisconnected = false;
  const fail = (message: string) => { if (!closed) options.onError?.(new Error(message)); };
  let rejectHandshake: ((error: Error) => void) | undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener('abort', close);
    rejectHandshake?.(abortError());
    ws.close();
  };
  options.signal?.addEventListener('abort', close, { once: true });

  ws.addEventListener('message', (message) => {
    if (closed) return;
    let packet: RelayServerPacket;
    try { packet = JSON.parse(String(message.data)) as RelayServerPacket; }
    catch { fail('Malformed Chatbus relay packet'); return; }
    if (packet.type === 'state') {
      sawDisconnected ||= packet.state === 'disconnected';
      options.onStateChange?.(packet.state);
    } else if (packet.type === 'event') options.onEvent(packet.event);
    else if (packet.type === 'error') fail(packet.message);
  });
  ws.addEventListener('error', () => fail('Chatbus relay WebSocket error'));
  ws.addEventListener('close', () => {
    if (!closed && !sawDisconnected) options.onStateChange?.('disconnected');
    closed = true;
    options.signal?.removeEventListener('abort', close);
    rejectHandshake?.(new Error('Chatbus relay closed before opening'));
  });

  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      if (closed) return;
      cleanup();
      try { ws.send(JSON.stringify({
        type: 'connect',
        protocol: RELAY_PROTOCOL_VERSION,
        platform: options.platform,
        target: options.target,
      })); } catch (error) { reject(error); close(); return; }
      resolve();
    };
    const onError = () => { rejectHandshake?.(new Error('Chatbus relay connection failed')); close(); };
    const cleanup = () => {
      rejectHandshake = undefined;
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
    };
    rejectHandshake = (error) => { cleanup(); reject(error); };
    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', onError, { once: true });
    if (options.signal?.aborted) close();
  });

  return { close };
}
