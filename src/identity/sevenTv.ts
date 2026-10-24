import { fetchJson, HttpError } from '../network/fetch';
import type {
  Badge,
  BadgeImage,
  EnrichmentResult,
  IdentityFetchOptions,
  NamePaint,
  NamePaintGradient,
  NamePaintShadow,
  NamePaintStop,
  NamePaintText,
  UserCosmetics,
} from '../types/identity';

export const SEVEN_TV_COSMETICS_CACHE_MS = 5 * 60 * 1000;

const API = 'https://7tv.io/v3';
const GQL = `${API}/gql`;

interface CacheEntry {
  expiresAt: number;
  value: UserCosmetics | null;
}

interface SevenTvStyle {
  paint_id?: string | null;
  badge_id?: string | null;
}

interface SevenTvUser {
  id?: string;
  username?: string;
  display_name?: string;
  style?: SevenTvStyle;
}

interface SevenTvConnection {
  id?: string;
  username?: string;
  display_name?: string;
  style?: SevenTvStyle;
  user?: SevenTvUser;
}

interface SevenTvPaintStop {
  at?: number;
  color?: number;
  center_at?: [number, number];
}

interface SevenTvPaintGradient {
  function?: string;
  canvas_repeat?: string;
  canvas_size?: [number, number];
  at?: [number, number];
  stops?: SevenTvPaintStop[];
  image_url?: string;
  shape?: string;
  angle?: number;
  repeat?: boolean;
}

interface SevenTvPaintShadow {
  x_offset?: number;
  y_offset?: number;
  radius?: number;
  color?: number;
}

interface SevenTvPaintText {
  weight?: number;
  variant?: string;
  transform?: string;
  stroke?: { width?: number; color?: number };
  shadows?: SevenTvPaintShadow[];
}

interface SevenTvPaint {
  id?: string;
  name?: string;
  color?: number | null;
  gradients?: SevenTvPaintGradient[];
  shadows?: SevenTvPaintShadow[];
  text?: SevenTvPaintText | null;
  function?: string;
  repeat?: boolean;
  angle?: number;
  shape?: string;
  image_url?: string;
  stops?: SevenTvPaintStop[];
}

interface SevenTvHostFile {
  name?: string;
  format?: string;
  width?: number;
  height?: number;
}

interface SevenTvBadge {
  id?: string;
  name?: string;
  tag?: string;
  tooltip?: string;
  host?: { url?: string; files?: SevenTvHostFile[] };
}

interface SevenTvCosmeticsResponse {
  data?: { cosmetics?: { paints?: SevenTvPaint[]; badges?: SevenTvBadge[] } };
  errors?: Array<{ message?: string }>;
}

const COSMETICS_QUERY = `query ChatbusCosmetics($list: [ObjectID!]) {
  cosmetics(list: $list) {
    paints {
      id name color function repeat angle shape image_url
      stops { at color center_at }
      shadows { x_offset y_offset radius color }
      text { weight variant transform stroke { width color } shadows { x_offset y_offset radius color } }
      gradients {
        function canvas_repeat canvas_size at image_url shape angle repeat
        stops { at color center_at }
      }
    }
    badges {
      id name tag tooltip
      host { url files { name format width height } }
    }
  }
}`;

const cache = new Map<string, CacheEntry>();
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : '7TV cosmetics lookup failed';
const normalizeUrl = (url: string): string => url.startsWith('//') ? `https:${url}` : url;
const ttlFor = (options: IdentityFetchOptions): number => options.cacheTtlMs ?? SEVEN_TV_COSMETICS_CACHE_MS;

export function clearSevenTvUserCosmeticsCache(twitchUserId?: string): void {
  if (twitchUserId) cache.delete(twitchUserId);
  else cache.clear();
}

const cacheValue = (twitchUserId: string, value: UserCosmetics | null, options: IdentityFetchOptions): void => {
  const ttl = ttlFor(options);
  if (ttl > 0) cache.set(twitchUserId, { value, expiresAt: Date.now() + ttl });
};

const mapStop = (stop: SevenTvPaintStop): NamePaintStop | null =>
  typeof stop.at === 'number' && typeof stop.color === 'number'
    ? { at: stop.at, color: stop.color, ...(stop.center_at ? { centerAt: stop.center_at } : {}) }
    : null;

const mapGradient = (gradient: SevenTvPaintGradient): NamePaintGradient => ({
  function: gradient.function,
  canvasRepeat: gradient.canvas_repeat,
  canvasSize: gradient.canvas_size,
  at: gradient.at,
  stops: (gradient.stops ?? []).map(mapStop).filter((stop): stop is NamePaintStop => stop !== null),
  imageUrl: gradient.image_url || undefined,
  shape: gradient.shape,
  angle: gradient.angle,
  repeat: gradient.repeat,
});

const mapShadow = (shadow: SevenTvPaintShadow): NamePaintShadow | null =>
  typeof shadow.x_offset === 'number' &&
  typeof shadow.y_offset === 'number' &&
  typeof shadow.radius === 'number' &&
  typeof shadow.color === 'number'
    ? { xOffset: shadow.x_offset, yOffset: shadow.y_offset, radius: shadow.radius, color: shadow.color }
    : null;

const mapText = (text: SevenTvPaintText | null | undefined): NamePaintText | undefined => {
  if (!text) return undefined;
  const stroke = text.stroke;
  return {
    ...(Number.isFinite(text.weight) ? { weight: text.weight } : {}),
    ...(typeof text.variant === 'string' ? { variant: text.variant } : {}),
    ...(typeof text.transform === 'string' ? { transform: text.transform } : {}),
    ...(stroke && Number.isFinite(stroke.width) && Number.isFinite(stroke.color)
      ? { stroke: { width: stroke.width!, color: stroke.color! } } : {}),
    shadows: (text.shadows ?? []).map(mapShadow).filter((shadow): shadow is NamePaintShadow => shadow !== null),
  };
};

const mapPaint = (paint: SevenTvPaint | undefined): NamePaint | undefined => {
  if (!paint?.id) return undefined;
  return {
    id: paint.id,
    provider: '7tv',
    name: paint.name,
    color: paint.color ?? undefined,
    gradients: (paint.gradients ?? []).map(mapGradient),
    shadows: (paint.shadows ?? []).map(mapShadow).filter((shadow): shadow is NamePaintShadow => shadow !== null),
    ...(paint.text ? { text: mapText(paint.text) } : {}),
    function: paint.function,
    repeat: paint.repeat,
    angle: paint.angle,
    shape: paint.shape,
    imageUrl: paint.image_url || undefined,
    stops: (paint.stops ?? []).map(mapStop).filter((stop): stop is NamePaintStop => stop !== null),
    raw: paint,
  };
};

const mapBadgeImages = (badge: SevenTvBadge): BadgeImage[] => {
  const host = badge.host?.url;
  if (!host) return [];
  const base = normalizeUrl(host).replace(/\/$/u, '');
  return (badge.host?.files ?? []).flatMap((file): BadgeImage[] => file.name ? [{
    url: `${base}/${file.name}`,
    width: file.width,
    height: file.height,
    format: file.format,
  }] : []);
};

const mapBadge = (badge: SevenTvBadge | undefined): Badge | undefined => {
  if (!badge?.id) return undefined;
  const images = mapBadgeImages(badge);
  if (images.length === 0) return undefined;
  return {
    id: badge.id,
    provider: '7tv',
    scope: 'user',
    name: badge.name,
    title: badge.tag,
    tooltip: badge.tooltip,
    images,
    raw: badge,
  };
};

export async function fetchSevenTvUserCosmeticsDetailed(
  twitchUserId: string,
  options: IdentityFetchOptions = {},
): Promise<EnrichmentResult<UserCosmetics>> {
  const cached = cache.get(twitchUserId);
  if (!options.bypassCache && cached && cached.expiresAt > Date.now()) {
    return { value: cached.value, ok: true };
  }

  try {
    const connection = await fetchJson<SevenTvConnection>(
      `${API}/users/twitch/${encodeURIComponent(twitchUserId)}`,
      { signal: options.signal },
    );
    const user = connection.user;
    const style = user?.style ?? connection.style;
    const paintId = style?.paint_id || undefined;
    const badgeId = style?.badge_id || undefined;
    const ids = [paintId, badgeId].filter((id): id is string => !!id);

    if (ids.length === 0) {
      cacheValue(twitchUserId, null, options);
      return { value: null, ok: true };
    }

    const response = await fetchJson<SevenTvCosmeticsResponse>(GQL, {
      signal: options.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationName: 'ChatbusCosmetics',
        variables: { list: ids },
        query: COSMETICS_QUERY,
      }),
    });
    if (response.errors?.length && !response.data?.cosmetics) {
      return {
        value: null,
        ok: false,
        error: response.errors.map((error) => error.message).filter(Boolean).join('; ') || '7TV GraphQL error',
      };
    }

    const paints = response.data?.cosmetics?.paints ?? [];
    const badges = response.data?.cosmetics?.badges ?? [];
    const paint = mapPaint(paints.find((candidate) => candidate.id === paintId));
    const badge = mapBadge(badges.find((candidate) => candidate.id === badgeId));
    const value: UserCosmetics = {
      provider: '7tv',
      userId: user?.id ?? connection.id,
      username: user?.username ?? connection.username,
      displayName: user?.display_name ?? connection.display_name,
      namePaint: paint,
      badges: badge ? [badge] : [],
    };
    cacheValue(twitchUserId, value, options);
    return { value, ok: true };
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      cacheValue(twitchUserId, null, options);
      return { value: null, ok: true };
    }
    return { value: null, ok: false, error: errorMessage(error) };
  }
}

export async function fetchSevenTvUserCosmetics(
  twitchUserId: string,
  options: IdentityFetchOptions = {},
): Promise<UserCosmetics | null> {
  return (await fetchSevenTvUserCosmeticsDetailed(twitchUserId, options)).value;
}
