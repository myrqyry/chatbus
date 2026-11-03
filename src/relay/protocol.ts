import type { ChatConnectionState, ChatEvent } from '../types/chat';

export const RELAY_PROTOCOL_VERSION = 1 as const;
export type RelayPlatform = 'twitch' | 'kick' | 'youtube';

export interface RelayConnectRequest {
  platform: RelayPlatform;
  target: string;
}

export interface RelayConnectCommand extends RelayConnectRequest {
  type: 'connect';
  protocol: typeof RELAY_PROTOCOL_VERSION;
}

export type RelayServerPacket =
  | { type: 'ready'; protocol: typeof RELAY_PROTOCOL_VERSION }
  | { type: 'state'; state: ChatConnectionState }
  | { type: 'event'; event: ChatEvent }
  | { type: 'error'; message: string };

const isPlatform = (value: unknown): value is RelayPlatform =>
  value === 'twitch' || value === 'kick' || value === 'youtube';

export function parseRelayCommand(input: string): RelayConnectCommand {
  let value: unknown;
  try { value = JSON.parse(input); } catch { throw new Error('Malformed relay command'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid relay command');
  const record = value as Record<string, unknown>;
  if (record.type !== 'connect' || !isPlatform(record.platform) || typeof record.target !== 'string') {
    throw new Error('Invalid relay connect command');
  }
  const target = record.target.trim();
  if (!target || target.length > 500) throw new Error('Relay target must be 1-500 characters');
  return { type: 'connect', platform: record.platform, target, protocol: RELAY_PROTOCOL_VERSION };
}
