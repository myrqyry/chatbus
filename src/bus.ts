import type { ChatConnectionState, ChatEvent, ChatPlatform } from './types/chat';
import { connectKickChat } from './platforms/kick/connect';
import type { KickConnectOptions } from './platforms/kick/types';
import { connectTwitchChat } from './platforms/twitch/connect';
import type { TwitchConnectOptions } from './platforms/twitch/types';
import { connectYouTubeChat } from './platforms/youtube/connect';
import type { YouTubeConnectOptions } from './platforms/youtube/types';

export interface ChatBusConnectionState {
  id: string;
  platform: Exclude<ChatPlatform, 'custom'>;
  target: string;
  state: ChatConnectionState;
}

export interface ChatBusErrorContext {
  id: string;
  platform: Exclude<ChatPlatform, 'custom'>;
  target: string;
}

export interface ChatBusOptions {
  onEvent: (event: ChatEvent) => void;
  onConnectionStateChange?: (connection: ChatBusConnectionState) => void;
  onError?: (error: Error, context: ChatBusErrorContext) => void;
}

type ManagedTwitchOptions = Omit<TwitchConnectOptions, 'onEvent' | 'onStateChange' | 'onError'>;
type ManagedKickOptions = Omit<KickConnectOptions, 'onEvent' | 'onStateChange' | 'onError'>;
type ManagedYouTubeOptions = Omit<YouTubeConnectOptions, 'onEvent' | 'onStateChange' | 'onError'>;

export type ChatBusConnectionSpec =
  | { id?: string; platform: 'twitch'; options: ManagedTwitchOptions }
  | { id?: string; platform: 'kick'; options: ManagedKickOptions }
  | { id?: string; platform: 'youtube'; options: ManagedYouTubeOptions };

export interface ChatBusConnectionHandle {
  id: string;
  platform: Exclude<ChatPlatform, 'custom'>;
  target: string;
  close: () => void;
}

export interface ChatBus {
  connect: (spec: ChatBusConnectionSpec) => Promise<ChatBusConnectionHandle>;
  disconnect: (id: string) => boolean;
  states: () => ChatBusConnectionState[];
  close: () => void;
}

const targetFor = (spec: ChatBusConnectionSpec): string => {
  if (spec.platform === 'youtube') {
    return spec.options.videoId?.trim() || spec.options.liveChatId?.trim() || 'youtube';
  }
  return spec.options.channel.trim();
};

export function createChatBus(options: ChatBusOptions): ChatBus {
  const handles = new Map<string, ChatBusConnectionHandle>();
  const pending = new Set<string>();
  const state = new Map<string, ChatBusConnectionState>();

  const updateState = (
    id: string,
    platform: Exclude<ChatPlatform, 'custom'>,
    target: string,
    next: ChatConnectionState,
  ) => {
    const previous = state.get(id);
    if (previous?.state === next && previous.platform === platform && previous.target === target) return;
    const value = { id, platform, target, state: next };
    state.set(id, value);
    options.onConnectionStateChange?.(value);
  };

  const connect = async (spec: ChatBusConnectionSpec): Promise<ChatBusConnectionHandle> => {
    const target = targetFor(spec);
    if (!target) throw new Error(`${spec.platform} connection target must not be empty`);
    const id = spec.id?.trim() || `${spec.platform}:${target.toLowerCase()}`;
    if (handles.has(id) || pending.has(id)) throw new Error(`Chatbus connection already exists: ${id}`);
    pending.add(id);

    const context: ChatBusErrorContext = { id, platform: spec.platform, target };
    const onStateChange = (next: ChatConnectionState) => updateState(id, spec.platform, target, next);
    const onError = (error: Error) => options.onError?.(error, context);
    updateState(id, spec.platform, target, 'connecting');

    try {
      let closeConnection: () => void;
      if (spec.platform === 'twitch') {
        const connection = await connectTwitchChat({
          ...spec.options,
          onEvent: options.onEvent,
          onStateChange,
          onError,
        });
        closeConnection = connection.close;
      } else if (spec.platform === 'kick') {
        const connection = await connectKickChat({
          ...spec.options,
          onEvent: options.onEvent,
          onStateChange,
          onError,
        });
        closeConnection = connection.close;
      } else {
        const connection = await connectYouTubeChat({
          ...spec.options,
          onEvent: options.onEvent,
          onStateChange,
          onError,
        });
        closeConnection = connection.close;
      }

      let closed = false;
      const handle: ChatBusConnectionHandle = {
        id,
        platform: spec.platform,
        target,
        close: () => {
          if (closed) return;
          closed = true;
          closeConnection();
          handles.delete(id);
          updateState(id, spec.platform, target, 'disconnected');
        },
      };
      handles.set(id, handle);
      pending.delete(id);
      return handle;
    } catch (error) {
      pending.delete(id);
      const resolved = error instanceof Error ? error : new Error(`Failed to connect ${spec.platform}`);
      updateState(id, spec.platform, target, 'error');
      options.onError?.(resolved, context);
      throw error;
    }
  };

  return {
    connect,
    disconnect: (id) => {
      const handle = handles.get(id);
      if (!handle) return false;
      handle.close();
      return true;
    },
    states: () => [...state.values()],
    close: () => {
      for (const handle of [...handles.values()]) handle.close();
    },
  };
}
