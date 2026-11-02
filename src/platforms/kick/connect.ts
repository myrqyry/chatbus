import type { KickChatConnection, KickConnectOptions, KickResolvedChannel } from './types';
import { resolveKickChannel } from './channel';
import { normalizeKickEvent } from './normalize';
import { fetchKickRecentMessages } from './history';
import type { ChatEvent } from '../../types/chat';
import { parseKickPusherFrame } from './protocol';
import { createKickSocket } from './socket';

export async function connectKickChat(options: KickConnectOptions): Promise<KickChatConnection> {
  const channelName = options.channel.trim();
  if (!channelName) throw new Error('Kick channel name must not be empty');

  let channel: KickResolvedChannel;
  if (options.chatroomId !== undefined) {
    if (!Number.isInteger(options.chatroomId) || options.chatroomId <= 0) {
      throw new Error('Kick chatroom id must be a positive integer');
    }
    channel = {
      channelName,
      channelId: options.channelId,
      chatroomId: options.chatroomId,
    };
  } else {
    const resolver = options.resolveChannel ?? ((name: string, signal?: AbortSignal) =>
      resolveKickChannel(name, { signal }));
    channel = await resolver(channelName, options.signal);
  }

  if (options.signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }

  let closed = false;
  let historyPending = options.emitInitialHistory === true && Boolean(channel.channelId);
  const historyController = new AbortController();
  const buffered: ChatEvent[] = [];
  const seenMessageIds = new Set<string>();
  const remember = (id: string) => {
    seenMessageIds.add(id);
    while (seenMessageIds.size > 500) {
      const oldest = seenMessageIds.values().next().value as string | undefined;
      if (oldest === undefined) break;
      seenMessageIds.delete(oldest);
    }
  };
  const deliver = (event: ChatEvent) => {
    if (closed) return;
    const id = event.type === 'message' ? event.message?.id : undefined;
    if (id && seenMessageIds.has(id)) return;
    if (id) remember(id);
    options.onEvent(event);
  };
  const receiveRealtime = (event: ChatEvent) => {
    if (closed) return;
    if (historyPending) buffered.push(event);
    else deliver(event);
  };
  const flushRealtime = () => {
    historyPending = false;
    if (closed) { buffered.length = 0; return; }
    for (const event of buffered.splice(0)) deliver(event);
  };

  const socket = createKickSocket(channel.chatroomId, {
    ...options.socket,
    channelId: channel.channelId,
    onStateChange: options.onStateChange,
    onError: options.onError,
    onMessage: (frame) => {
      const parsed = parseKickPusherFrame(frame);
      if (!parsed) return;
      const event = normalizeKickEvent(parsed, {
        channelName: channel.channelName,
        channelId: channel.channelId ?? String(channel.chatroomId),
        emotes: options.getEmotes?.() ?? options.emotes,
      });
      if (event) receiveRealtime(event);
    },
  });

  if (historyPending) {
    void fetchKickRecentMessages(channel, {
      limit: options.initialHistoryLimit,
      signal: historyController.signal,
    }).then(events => {
      if (closed) return;
      for (const event of events) deliver(event);
      flushRealtime();
    }, () => flushRealtime());
  }

  const close = () => {
    if (closed) return;
    closed = true;
    historyController.abort();
    buffered.length = 0;
    socket.close();
  };
  options.signal?.addEventListener('abort', close, { once: true });

  return {
    channel,
    close: () => {
      options.signal?.removeEventListener('abort', close);
      close();
    },
  };
}
