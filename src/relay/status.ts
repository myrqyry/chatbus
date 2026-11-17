import { RELAY_PROTOCOL_VERSION, type RelayPlatform } from './protocol';

export interface LocalChatbusRelayStatus {
  available: boolean;
  protocol: typeof RELAY_PROTOCOL_VERSION;
  platforms: RelayPlatform[];
}

const unavailable = (): LocalChatbusRelayStatus => ({
  available: false, protocol: RELAY_PROTOCOL_VERSION, platforms: [],
});
const isPlatform = (value: unknown): value is RelayPlatform =>
  value === 'twitch' || value === 'kick' || value === 'youtube';
const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

/** Discover the same-origin relay, not upstream provider readiness. */
export async function getLocalChatbusRelayStatus(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<LocalChatbusRelayStatus> {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 2000);
  try {
    const response = await fetcher('/api/chatbus/status', { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return unavailable();
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
    const body = value as Record<string, unknown>;
    if (controller.signal.aborted || body.available !== true ||
        body.protocol !== RELAY_PROTOCOL_VERSION || !Array.isArray(body.platforms)) {
      return unavailable();
    }
    return { available: true, protocol: RELAY_PROTOCOL_VERSION, platforms: [...new Set(body.platforms.filter(isPlatform))] };
  } catch {
    return unavailable();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (signal?.aborted) throw abortError();
  }
}
