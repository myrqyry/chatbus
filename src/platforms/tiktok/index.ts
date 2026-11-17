import type { ChatConnectionState, ChatEvent, ChatUser } from '../../types/chat';
import type { EmoteSet } from '../../types/emotes';
import { parseMessageFragments } from '../../messages/parse';

export interface TikTokNormalizeContext {
  channel: string;
  roomId?: string;
  receivedAt: number;
  emotes?: EmoteSet;
}
type Payload = Record<string, unknown>;
const record = (value: unknown): Payload =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Payload : {};
const string = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;
const id = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() && value !== '0' ? value :
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function normalizeTikTokChannel(input: string): string {
  let channel = input.trim();
  if (channel.includes('://')) {
    const url = new URL(channel);
    const match = /^\/@([a-z0-9._]+)(?:\/live)?\/?$/i.exec(url.pathname);
    if (url.protocol !== 'https:' || !['www.tiktok.com', 'tiktok.com'].includes(url.hostname) ||
        url.username || url.password || url.port || !match) throw new Error('Invalid TikTok LIVE URL');
    channel = match[1]!;
  }
  channel = channel.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,24}$/.test(channel)) throw new Error('Invalid TikTok username');
  return channel;
}
function timestamp(value: unknown, receivedAt: number): number {
  const numeric = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isSafeInteger(numeric) || numeric <= 0) return receivedAt;
  const ms = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  return Number.isSafeInteger(ms) ? ms : receivedAt;
}

/** Pinned v3 decoded webcast fields. Never invent a sender or lose precision
 * by coercing a 64-bit TikTok identifier through Number. */
export function normalizeTikTokEvent(kind: 'chat' | 'gift' | 'follow' | 'streamEnd',
  value: unknown, context: TikTokNormalizeContext): ChatEvent | null {
  const payload = record(value), common = record(payload.common), sender = record(payload.user);
  const roomId = id(common.roomId) ?? context.roomId;
  if (context.roomId && roomId !== context.roomId) return null;
  const eventId = id(common.msgId);
  const base = { platform: 'tiktok' as const, channelName: context.channel, channelId: roomId,
    timestamp: timestamp(common.createTime, context.receivedAt), id: eventId, raw: value };
  if (kind === 'streamEnd') return { ...base, type: 'stream-offline' };
  const username = string(sender.displayId) ?? string(sender.uniqueId);
  if (!username) return null;
  const user: ChatUser = { platform: 'tiktok', id: id(sender.id) ?? id(sender.userId),
    username, displayName: string(sender.nickname) ?? username };
  if (kind === 'chat') {
    const text = string(payload.content) ?? string(payload.comment);
    if (!text || !eventId) return null;
    return { ...base, type: 'message', user, message: {
      ...base, id: eventId, user, text, fragments: parseMessageFragments(text, { emotes: context.emotes }),
    } };
  }
  if (kind === 'follow') return { ...base, type: 'follow', user };
  const gift = record(payload.gift), details = record(payload.giftDetails);
  const giftId = id(payload.giftId), repeats = count(payload.repeatCount);
  const giftType = count(gift.type) ?? count(details.giftType);
  // Unknown streak semantics are not a confirmed final gift.
  if (!giftId || !repeats || giftType === undefined ||
      (giftType === 1 && payload.repeatEnd !== 1 && payload.repeatEnd !== true)) return null;
  return { ...base, type: 'donation', user, data: {
    source: 'tiktok-live', giftId, giftName: string(gift.name) ?? string(details.giftName),
    count: repeats, diamondsPerGift: count(gift.diamondCount) ?? count(details.diamondCount),
  } };
}

export interface TikTokDriver {
  on(event: string, callback: (payload: unknown) => void): unknown;
  off(event: string, callback: (payload: unknown) => void): unknown;
  connect(): Promise<{ isConnected: boolean; roomId: string }>;
  disconnect(): Promise<void>;
}
export interface TikTokConnectOptions {
  channel: string;
  onEvent: (event: ChatEvent) => void;
  onStateChange?: (state: ChatConnectionState) => void;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
  getEmotes?: () => EmoteSet;
  /** Optional host-owned driver for explicit signing configuration/testing. */
  createDriver?: (channel: string) => TikTokDriver | Promise<TikTokDriver>;
}
export interface TikTokConnection { channel: string; close(): void; }

/** Optional Node dependency, never statically imported into browser bundles.
 * Use the host's SIGN_API_KEY environment configuration if required.
 * No TikTok sessions, authenticated routes or initial history. */
export async function createTikTokLiveDriver(channel: string): Promise<TikTokDriver> {
  if (typeof process === 'undefined' || !process.versions?.node) throw new Error('TikTok LIVE requires a Node host');
  const dependency = 'tiktok-live-connector';
  const upstream = await import(/* @vite-ignore */ dependency).catch((error: unknown) => {
    const code = record(error).code;
    throw new Error(code === 'ERR_MODULE_NOT_FOUND'
      ? 'TikTok LIVE requires optional host dependency tiktok-live-connector@2.4.0'
      : 'TikTok LIVE requires a working tiktok-live-connector@2.4.0 installation');
  });
  const metadata = await import(/* @vite-ignore */ dependency + '/package.json', { with: { type: 'json' } });
  if (metadata.default.version !== '2.4.0') throw new Error('TikTok LIVE requires connector version 2.4.0');
  return new upstream.TikTokLiveConnection(channel, {
    processInitialData: false, fetchRoomInfoOnConnect: true,
    authenticateWs: false, useMobile: false, enableExtendedGiftInfo: false,
    webClientOptions: { timeout: { request: 10000 }, retry: { limit: 0 } },
    wsClientOptions: { handshakeTimeout: 10000 },
  }) as TikTokDriver;
}

/** Return lifetime ownership immediately, even while provider setup is pending.
 * Manual retry only: don't hammer a metered signing service on refusal/offline. */
export function connectTikTokChat(options: TikTokConnectOptions): TikTokConnection {
  const channel = normalizeTikTokChannel(options.channel);
  if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  let closed = false, ready = false, driver: TikTokDriver | undefined, roomId: string | undefined;
  const seen = new Set<string>();
  const listeners: [string, (value: unknown) => void][] = [];
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const clearDeadline = () => { if (deadline !== undefined) clearTimeout(deadline); deadline = undefined; };
  const release = async (target: TikTokDriver) => {
    try { await target.disconnect(); } catch { /* teardown remains terminal */ }
  };
  const close = (state: 'disconnected' | 'error' = 'disconnected') => {
    if (closed) return;
    closed = true; ready = false; clearDeadline();
    options.signal?.removeEventListener('abort', abort);
    if (driver) {
      const target = driver;
      for (const [name, callback] of listeners) target.off(name, callback);
      void release(target);
    }
    seen.clear();
    options.onStateChange?.(state);
  };
  const abort = () => close();
  const fail = (message: string) => {
    if (closed) return;
    close('error');
    options.onError?.(new Error(message));
  };
  const deliver = (kind: 'chat' | 'gift' | 'follow' | 'streamEnd', value: unknown) => {
    if (!ready || closed) return;
    const event = normalizeTikTokEvent(kind, value, { channel, roomId, receivedAt: Date.now(), emotes: options.getEmotes?.() });
    if (!event) return;
    if (event.id) {
      const key = event.type + ':' + event.id;
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > 2048) seen.delete(seen.values().next().value!);
    }
    options.onEvent({ ...event, origin: 'live' });
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  options.onStateChange?.('connecting');
  if (closed) return { channel, close: abort };
  deadline = setTimeout(() => fail('TikTok LIVE connection timed out'), 25000);
  void (async () => {
    try {
      const target = await (options.createDriver ?? createTikTokLiveDriver)(channel);
      if (closed) { await release(target); return; }
      driver = target;
      const listen = (name: string, callback: (value: unknown) => void) => {
        listeners.push([name, callback]); target.on(name, callback);
      };
      for (const kind of ['chat', 'gift', 'follow'] as const) listen(kind, value => deliver(kind, value));
      listen('streamEnd', value => { deliver('streamEnd', value); close(); });
      listen('disconnected', () => { if (ready) close(); });
      listen('error', () => {
        // The SDK emits an error and then rejects setup; let the rejection
        // settle once. On a live connection, surface an error and stop.
        if (ready) fail('TikTok LIVE transport error');
      });
      const state = await target.connect();
      if (closed) { await release(target); return; }
      if (!state.isConnected || !id(state.roomId)) { fail('TikTok LIVE did not confirm room readiness'); return; }
      roomId = state.roomId; ready = true; clearDeadline();
      options.onStateChange?.('connected');
    } catch (error) {
      // SDK errors can contain signing credentials in request descriptions.
      // Report a bounded safe category rather than forwarding raw URLs.
      const name = error instanceof Error ? error.name : '';
      const message = error instanceof Error && error.message.startsWith('TikTok LIVE requires') ? error.message :
        name === 'UserOfflineError' ? 'TikTok creator is not live' :
        name === 'SignatureRateLimitError' ? 'TikTok LIVE signing rate limit reached' :
        'TikTok LIVE connection failed; check stream availability and signing configuration';
      fail(message);
    }
  })();
  return { channel, close: abort };
}
