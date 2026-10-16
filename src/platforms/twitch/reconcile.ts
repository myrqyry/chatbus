import { fetchWithTimeout } from '../../network/fetch';
import type { TwitchAuth, TwitchEventSubSubscription } from './types';

const API_URL = 'https://api.twitch.tv/helix/eventsub/subscriptions';
const MAX_PAGES = 100;

/** Query Twitch's authoritative subscription list; do not infer health from a live socket. */
export async function listEnabledTwitchEventSubSubscriptions(
  auth: TwitchAuth,
  signal?: AbortSignal,
): Promise<TwitchEventSubSubscription[]> {
  const records: TwitchEventSubSubscription[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(API_URL);
    url.searchParams.set('status', 'enabled');
    if (cursor) url.searchParams.set('after', cursor);
    const response = await fetchWithTimeout(url.toString(), {
      headers: { 'Client-Id': auth.clientId, Authorization: `Bearer ${auth.accessToken}` },
      signal,
    }, 5_000, 0);
    if (!response.ok) {
      throw new Error(`Twitch EventSub subscription health check failed with ${response.status}`);
    }

    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || !('data' in payload) ||
      !Array.isArray(payload.data) ||
      payload.data.some((entry) => !entry || typeof entry !== 'object' ||
        typeof entry.id !== 'string' || typeof entry.type !== 'string' ||
        typeof entry.status !== 'string' || !entry.transport ||
        typeof entry.transport !== 'object' ||
        typeof entry.transport.method !== 'string' ||
        (entry.transport.method === 'websocket' && typeof entry.transport.session_id !== 'string') ||
        !entry.condition || typeof entry.condition !== 'object')) {
      throw new Error('Twitch EventSub subscription health response is malformed');
    }
    records.push(...payload.data as TwitchEventSubSubscription[]);
    const pagination = 'pagination' in payload ? payload.pagination : undefined;
    const next = pagination && typeof pagination === 'object' && 'cursor' in pagination &&
      typeof pagination.cursor === 'string' && pagination.cursor ? pagination.cursor : undefined;
    if (!next) return records;
    if (cursors.has(next)) throw new Error('Twitch EventSub pagination cursor repeated');
    cursors.add(next);
    cursor = next;
  }
  throw new Error('Twitch EventSub subscription health pagination exceeded safety limit');
}
