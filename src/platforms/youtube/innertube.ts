import type { ChatConnectionState, ChatEvent } from '../../types/chat';
import { createChatBus, type ChatBusOptions } from '../../bus';
import {
  normalizeYouTubeInnertubeChatItem,
  type YouTubeInnertubeChatItem,
} from './innertube-normalize';

export interface YouTubeInnertubeOptions {
  /** Exactly one channel handle, channel ID or live video ID. No API credentials required. */
  handle?: string;
  channelId?: string;
  liveId?: string;
  /** Minimum poll interval in ms; the upstream reader also honors YouTube's own requested cadence. */
  minPollMs?: number;
  signal?: AbortSignal;
  onEvent: (event: ChatEvent) => void;
  onStateChange?: (state: ChatConnectionState) => void;
  onError?: (error: Error) => void;
}

export interface YouTubeInnertubeConnection {
  liveId?: string;
  close: () => void;
}

const MAX_DEDUPE = 2_000;

/** Node-only, unofficial public YouTube read-only source. Intentionally isolated from the official API. */
export async function connectYouTubeInnertubeChat(
  options: YouTubeInnertubeOptions,
): Promise<YouTubeInnertubeConnection> {
  const candidates = [options.handle?.trim(), options.channelId?.trim(), options.liveId?.trim()]
    .filter((value): value is string => Boolean(value));
  if (candidates.length !== 1) {
    throw new TypeError('YouTube InnerTube requires exactly one handle, channelId, or liveId');
  }
  if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  const minPollMs = options.minPollMs ?? 1_000;
  if (!Number.isFinite(minPollMs) || minPollMs < 1_000) {
    throw new RangeError('YouTube InnerTube minimum poll interval must be at least 1000 ms');
  }

  // The dependency is loaded only for this optional Node-specific export.
  const { LiveChat } = await import('youtube-chat-next');
  const target = options.handle
    ? { handle: candidates[0] }
    : options.channelId ? { channelId: candidates[0] } : { liveId: candidates[0] };
  const source = new LiveChat(target, minPollMs, 'live');
  const channelId = options.channelId?.trim();
  const channelName = options.handle?.trim();
  const seen = new Set<string>();
  let closed = false;
  let reportedError = false;
  options.onStateChange?.('connecting');

  const close = () => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener('abort', close);
    source.removeListener('chat', onChat);
    source.removeListener('error', onError);
    source.removeListener('start', onStart);
    source.removeListener('end', onEnd);
    source.stop('Stopped by Chatbus');
    options.onStateChange?.('disconnected');
  };
  const onStart = () => {
    if (!closed) options.onStateChange?.('connected');
  };
  const onChat = (item: YouTubeInnertubeChatItem) => {
    if (closed || !item.id || seen.has(item.id)) return;
    const event = normalizeYouTubeInnertubeChatItem(item, { channelId, channelName });
    if (!event) return;
    seen.add(item.id);
    while (seen.size > MAX_DEDUPE) {
      const oldest = seen.values().next().value;
      if (!oldest) break;
      seen.delete(oldest);
    }
    options.onEvent({ ...event, origin: 'live' });
  };
  const onError = (error: unknown) => {
    if (closed) return;
    reportedError = true;
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
    options.onStateChange?.('reconnecting');
  };
  const onEnd = (reason?: string) => {
    if (closed) return;
    if (reason === 'Live stream ended') {
      options.onEvent({
        id: `youtube-innertube:offline:${source.liveId ?? candidates[0]}`,
        type: 'stream-offline',
        platform: 'youtube',
        channelId,
        channelName,
        timestamp: Date.now(),
        origin: 'live',
        data: { liveId: source.liveId, reason, transport: 'innertube' },
      });
    }
    close();
  };
  source.on('chat', onChat);
  source.on('error', onError);
  source.on('start', onStart);
  source.on('end', onEnd);
  options.signal?.addEventListener('abort', close, { once: true });

  try {
    const started = await source.start();
    if (closed || options.signal?.aborted) {
      close();
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    if (!started) {
      close();
      throw new Error('Unable to start YouTube InnerTube live chat');
    }
  } catch (error) {
    if (!reportedError && !closed) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
    close();
    throw error;
  }
  return { liveId: source.liveId ?? options.liveId, close };
}

/** Node-only Chatbus manager with both official and optional public YouTube modes. */
export function createNodeChatBus(options: Omit<ChatBusOptions, 'connectYouTubeInnertube'>) {
  return createChatBus({ ...options, connectYouTubeInnertube: connectYouTubeInnertubeChat });
}
