import { fetchJson } from '../network/fetch';

/**
 * Public Twitch identity artwork for anonymous overlays.
 * IVR is a third-party mirror; failures must not hold up a chat connection.
 */
const IVR_USER_URL = 'https://api.ivr.fi/v2/twitch/user';
const SUCCESS_TTL_MS = 30 * 60_000;
const FAILURE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 256;
const VALID_LOGIN = /^[a-z0-9_]{1,25}$/;

export interface TwitchPublicIdentity {
  avatarUrl: string | null;
  /** Twitch's own selected chat-name color, not the current viewer's color. */
  chatColor: string | null;
}
const cache = new Map<string, { value: TwitchPublicIdentity | null; expiresAt: number }>();
const pending = new Map<string, Promise<TwitchPublicIdentity | null>>();

function safeAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'static-cdn.jtvnw.net'
      && url.pathname.startsWith('/jtv_user_pictures/')
      && !url.username && !url.password
      ? url.href : null;
  } catch {
    return null;
  }
}

/** Clear one user's cached artwork or every entry, for testing or manual refresh. */
export function clearTwitchAvatarCache(login?: string): void {
  if (login) cache.delete(login.trim().toLowerCase());
  else cache.clear();
}

/** Load public artwork and owner chat color from one bounded, cached lookup.
 * No default is invented when a user never selected a Twitch chat color.
 */
export function fetchTwitchUserIdentity(login: string): Promise<TwitchPublicIdentity | null> {
  const key = login.trim().toLowerCase();
  if (!VALID_LOGIN.test(key)) return Promise.resolve(null);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
  const existing = pending.get(key);
  if (existing) return existing;

  const task = fetchJson<unknown>(`${IVR_USER_URL}?login=${encodeURIComponent(key)}`)
    .then(response => {
      if (!Array.isArray(response)) return null;
      const row = response[0];
      if (!row || typeof row !== 'object') return null;
      const details = row as Record<string, unknown>;
      const rawColor = details.chatColor;
      return {
        avatarUrl: safeAvatarUrl(details.logo),
        chatColor: typeof rawColor === 'string' && /^#[0-9a-f]{6}$/i.test(rawColor)
          ? rawColor : null,
      };
    })
    .catch(() => null)
    .then(value => {
      cache.delete(key);
      cache.set(key, {
        value,
        expiresAt: Date.now() + (value?.avatarUrl ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
      });
      while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
      return value;
    })
    .finally(() => { pending.delete(key); });
  pending.set(key, task);
  return task;
}

/** Backwards-compatible image-only API, sharing the exact same lookup/cache. */
export function fetchTwitchUserAvatar(login: string): Promise<string | null> {
  return fetchTwitchUserIdentity(login).then(identity => identity?.avatarUrl ?? null);
}
