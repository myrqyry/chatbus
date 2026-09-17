import { fetchWithTimeout } from '../../network/fetch';
import type { ChatEvent } from '../../types/chat';
import { normalizeYouTubeLiveChatMessage } from './normalize';
import type {
  YouTubeChatConnection,
  YouTubeConnectOptions,
  YouTubeLiveChatListResponse,
  YouTubeLiveChatMessageResource,
  YouTubeResolvedLiveChat,
} from './types';

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const MIN_POLL_MS = 100;
const DEFAULT_POLL_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const DEDUPE_MAX = 2_000;

const credentialsFor = (options: Pick<YouTubeConnectOptions, 'apiKey' | 'accessToken'>) => {
  const apiKey = options.apiKey?.trim();
  const accessToken = options.accessToken?.trim();
  if (!apiKey && !accessToken) {
    throw new Error('YouTube chat requires an API key or OAuth access token');
  }
  return { apiKey, accessToken };
};

const request = async (
  path: string,
  params: URLSearchParams,
  credentials: ReturnType<typeof credentialsFor>,
  signal?: AbortSignal,
): Promise<Response> => {
  if (credentials.apiKey) params.set('key', credentials.apiKey);
  const headers = credentials.accessToken
    ? { Authorization: `Bearer ${credentials.accessToken}` }
    : undefined;
  return fetchWithTimeout(`${API_BASE}${path}?${params.toString()}`, { headers, signal }, 10_000, 0);
};

class YouTubeApiError extends Error {
  readonly status: number;
  readonly reason?: string;

  constructor(label: string, status: number, message?: string, reason?: string) {
    super(`${label} failed with ${status}${message ? `: ${message}` : ''}`);
    this.name = 'YouTubeApiError';
    this.status = status;
    this.reason = reason;
  }
}

const responseError = async (response: Response, label: string): Promise<YouTubeApiError> => {
  let message: string | undefined;
  let reason: string | undefined;
  try {
    const payload = await response.json() as {
      error?: { message?: string; errors?: Array<{ reason?: string }> };
    };
    message = payload.error?.message;
    reason = payload.error?.errors?.find((entry) => entry.reason)?.reason;
  } catch {
    // Status is still useful when Google does not return JSON.
  }
  return new YouTubeApiError(label, response.status, message, reason);
};

const TERMINAL_LIVE_CHAT_REASONS = new Set([
  'forbidden',
  'liveChatDisabled',
  'liveChatEnded',
  'liveChatNotFound',
]);

export async function resolveYouTubeLiveChat(
  videoId: string,
  options: Pick<YouTubeConnectOptions, 'apiKey' | 'accessToken' | 'signal'>,
): Promise<YouTubeResolvedLiveChat> {
  const normalizedVideoId = videoId.trim();
  if (!normalizedVideoId) throw new Error('YouTube video id must not be empty');
  const credentials = credentialsFor(options);
  const params = new URLSearchParams({
    part: 'liveStreamingDetails,snippet',
    id: normalizedVideoId,
  });
  const response = await request('/videos', params, credentials, options.signal);
  if (!response.ok) throw await responseError(response, 'YouTube video lookup');
  const payload = await response.json() as {
    items?: Array<{
      snippet?: { channelId?: string; channelTitle?: string };
      liveStreamingDetails?: { activeLiveChatId?: string };
    }>;
  };
  const item = payload.items?.[0];
  const liveChatId = item?.liveStreamingDetails?.activeLiveChatId;
  if (!liveChatId) throw new Error(`YouTube video has no active live chat: ${normalizedVideoId}`);
  return {
    videoId: normalizedVideoId,
    liveChatId,
    channelId: item?.snippet?.channelId,
    channelName: item?.snippet?.channelTitle,
  };
}

const waitFor = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => signal.removeEventListener('abort', abort);
  const finish = () => {
    cleanup();
    resolve();
  };
  const abort = () => {
    if (timer !== undefined) clearTimeout(timer);
    cleanup();
    reject(new DOMException('The operation was aborted.', 'AbortError'));
  };
  if (signal.aborted) return abort();
  signal.addEventListener('abort', abort, { once: true });
  timer = setTimeout(finish, ms);
});

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

export async function connectYouTubeChat(options: YouTubeConnectOptions): Promise<YouTubeChatConnection> {
  const credentials = credentialsFor(options);
  if (!options.liveChatId?.trim() && !options.videoId?.trim()) {
    throw new Error('YouTube chat requires videoId or liveChatId');
  }
  if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');

  const resolved = options.liveChatId?.trim()
    ? {
        videoId: options.videoId?.trim() || undefined,
        liveChatId: options.liveChatId.trim(),
        channelId: options.channelId,
        channelName: options.channelName,
      }
    : await resolveYouTubeLiveChat(options.videoId!, options);

  const liveChat: YouTubeResolvedLiveChat = {
    ...resolved,
    channelId: options.channelId ?? resolved.channelId,
    channelName: options.channelName ?? resolved.channelName,
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let pageToken: string | undefined;
  let connected = false;
  let firstPage = true;
  let reconnectAttempt = 0;
  let offlineEventSent = false;
  const seen = new Set<string>();

  const eventKey = (item: YouTubeLiveChatMessageResource): string => {
    if (item.snippet?.type === 'giftEvent') {
      return `${item.id}:gift:${item.snippet.giftEventDetails?.giftMetadata?.comboCount ?? 0}`;
    }
    if (item.snippet?.type === 'pollEvent') {
      return `${item.id}:poll:${JSON.stringify(item.snippet.pollDetails ?? null)}`;
    }
    return item.id;
  };

  const remember = (item: YouTubeLiveChatMessageResource): boolean => {
    const key = eventKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    while (seen.size > DEDUPE_MAX) {
      const oldest = seen.values().next().value as string | undefined;
      if (!oldest) break;
      seen.delete(oldest);
    }
    return true;
  };

  const emitOffline = (offlineAt: string) => {
    if (offlineEventSent) return;
    offlineEventSent = true;
    options.onEvent({
      id: `youtube-offline:${liveChat.liveChatId}:${offlineAt}`,
      type: 'stream-offline',
      platform: 'youtube',
      channelId: liveChat.channelId,
      channelName: liveChat.channelName,
      timestamp: Number.isFinite(Date.parse(offlineAt)) ? Date.parse(offlineAt) : Date.now(),
      origin: 'live',
      data: { videoId: liveChat.videoId, liveChatId: liveChat.liveChatId, offlineAt },
    });
  };

  const loop = async () => {
    options.onStateChange?.('connecting');
    while (!controller.signal.aborted) {
      try {
        const params = new URLSearchParams({
          part: 'id,snippet,authorDetails',
          liveChatId: liveChat.liveChatId,
          maxResults: String(Math.min(200, Math.max(1, options.maxResults ?? 200))),
          profileImageSize: String(Math.min(720, Math.max(16, options.profileImageSize ?? 88))),
        });
        if (pageToken) params.set('pageToken', pageToken);
        const response = await request('/liveChat/messages', params, credentials, controller.signal);
        if (!response.ok) throw await responseError(response, 'YouTube live chat request');
        const payload = await response.json() as YouTubeLiveChatListResponse;
        pageToken = payload.nextPageToken ?? pageToken;

        if (!connected) {
          connected = true;
          options.onStateChange?.('connected');
        }
        reconnectAttempt = 0;

        const pageItems = [
          ...(payload.items ?? []),
          ...(payload.activePollItem ? [payload.activePollItem] : []),
        ];
        const shouldEmit = !firstPage || options.emitInitialHistory !== false;
        if (shouldEmit) {
          for (const item of pageItems) {
            if (!item.id || !remember(item)) continue;
            const event = normalizeYouTubeLiveChatMessage(item, {
              liveChatId: liveChat.liveChatId,
              videoId: liveChat.videoId,
              channelId: liveChat.channelId,
              channelName: liveChat.channelName,
            });
            if (event) options.onEvent(event);
          }
        } else {
          for (const item of pageItems) if (item.id) remember(item);
        }
        firstPage = false;

        if (payload.offlineAt) {
          emitOffline(payload.offlineAt);
          break;
        }

        const pollMs = Math.max(MIN_POLL_MS, payload.pollingIntervalMillis ?? DEFAULT_POLL_MS);
        await waitFor(pollMs, controller.signal);
      } catch (error) {
        if (controller.signal.aborted || isAbort(error)) break;
        const resolvedError = error instanceof Error ? error : new Error('YouTube chat connection failed');
        options.onError?.(resolvedError);
        if (error instanceof YouTubeApiError && error.reason && TERMINAL_LIVE_CHAT_REASONS.has(error.reason)) {
          if (error.reason === 'liveChatEnded') {
            options.onEvent({
              id: `youtube-chat-ended:${liveChat.liveChatId}`,
              type: 'system',
              platform: 'youtube',
              channelId: liveChat.channelId,
              channelName: liveChat.channelName,
              timestamp: Date.now(),
              origin: 'live',
              data: { kind: 'chat-ended', reason: error.reason, liveChatId: liveChat.liveChatId },
            });
          }
          break;
        }
        options.onStateChange?.('reconnecting');
        const delay = Math.min(1_000 * (2 ** reconnectAttempt++), MAX_RECONNECT_MS);
        try {
          await waitFor(delay, controller.signal);
        } catch {
          break;
        }
      }
    }
    if (!controller.signal.aborted) options.onStateChange?.('disconnected');
  };

  void loop();

  return {
    liveChat,
    close: () => {
      options.signal?.removeEventListener('abort', abort);
      if (!controller.signal.aborted) controller.abort();
      options.onStateChange?.('disconnected');
    },
  };
}
