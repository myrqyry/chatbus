import { fetchJson } from '../../network/fetch';
import {loadKickChannelMetadata} from './channel-metadata';
import type { KickChannelInfo, KickResolvedChannel } from './types';

export interface ResolveKickChannelOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
  baseUrl?: string;
  /** Bypass overlapping startup requests for a post-reconnect snapshot. */
  fresh?:boolean;
}

export async function resolveKickChannel(
  channel: string,
  options: ResolveKickChannelOptions = {},
): Promise<KickResolvedChannel> {
  const channelName = channel.trim();
  if (!channelName) throw new Error('Kick channel name must not be empty');

  const baseUrl = (options.baseUrl ?? 'https://kick.com').replace(/\/$/u, '');
  const info = options.baseUrl===undefined&&options.timeoutMs===undefined&&options.retries===undefined
    ? await loadKickChannelMetadata(channelName,options.signal,options.fresh) as KickChannelInfo
    : await fetchJson<KickChannelInfo>(
    `${baseUrl}/api/v2/channels/${encodeURIComponent(channelName)}`,
    { signal: options.signal },
    options.timeoutMs,
    options.retries,
  );

  const chatroomId = info.chatroom?.id;
  if (typeof chatroomId !== 'number' || !Number.isInteger(chatroomId) || chatroomId <= 0) {
    throw new Error('Kick channel response did not include a valid chatroom id');
  }

  return {
    channelName: info.slug || channelName,
    channelId: info.id == null ? undefined : String(info.id),
    chatroomId,
    raw: info,
  };
}
