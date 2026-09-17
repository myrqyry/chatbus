import type { KickChatConnection, KickConnectOptions, KickResolvedChannel } from './types';
import { resolveKickChannel } from './channel';
import { normalizeKickEvent } from './normalize';
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
      if (event) options.onEvent(event);
    },
  });

  const close = () => socket.close();
  options.signal?.addEventListener('abort', close, { once: true });

  return {
    channel,
    close: () => {
      options.signal?.removeEventListener('abort', close);
      close();
    },
  };
}
