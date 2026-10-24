import { fetchJson } from '../network/fetch';
import type { EnrichmentResult, IdentityFetchOptions, NamePaint, NamePaintLayer, NamePaintShadow, NamePaintStop } from '../types/identity';

const V4_GQL = 'https://7tv.io/v4/gql';
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_LAYERS = 12;
const MAX_STOPS = 32;

interface Color { hex?: string }
interface StopPayload { at?: number; color?: Color }
interface PaintLayerPayload {
  id?: string;
  opacity?: number;
  ty?: {
    __typename?: string;
    color?: Color;
    angle?: number;
    repeating?: boolean;
    shape?: string;
    stops?: StopPayload[];
    images?: { url?: string; scale?: number; frameCount?: number }[];
  };
}
interface PaintDataPayload {
  layers?: PaintLayerPayload[];
  shadows?: { offsetX?: number; offsetY?: number; blur?: number; color?: Color }[];
}
interface PaintResponse {
  data?: { users?: { userByConnection?: {
    style?: { activePaint?: { id?: string } | null };
    inventory?: { paints?: ({ to?: { paint?: { id?: string; name?: string; data?: PaintDataPayload | null } } } | null)[] };
  } | null } };
  errors?: { message?: string }[];
}

const QUERY = [
  'query ChatbusSevenTvPaint($platformId: String!) {',
  'users { userByConnection(platform: TWITCH, platformId: $platformId) {',
  'style { activePaint { id } }',
  'inventory(includeInaccessible: true) { paints { to { paint { id name data {',
  'layers { id opacity ty { __typename',
  '... on PaintLayerTypeImage { images { url scale frameCount } }',
  '... on PaintLayerTypeRadialGradient { repeating shape stops { at color { hex } } }',
  '... on PaintLayerTypeLinearGradient { angle repeating stops { at color { hex } } }',
  '... on PaintLayerTypeSingleColor { color { hex } }',
  '} }',
  'shadows { offsetX offsetY blur color { hex } }',
  '} } } } }',
  '} } }',
].join(' ');

const cache = new Map<string, { expiresAt: number; value: NamePaint | null }>();
const inFlight = new Map<string, Promise<EnrichmentResult<NamePaint>>>();

/** 7TV v4 colors use RGBA hex; Chatbus names paint colors as ARGB integers. */
const colorArgb = (color: Color | undefined): number | null => {
  const hex = color?.hex;
  if (!hex || !/^#[0-9a-f]{8}$/iu.test(hex)) return null;
  return ((parseInt(hex.slice(7, 9), 16) << 24) |
    (parseInt(hex.slice(1, 3), 16) << 16) |
    (parseInt(hex.slice(3, 5), 16) << 8) |
    parseInt(hex.slice(5, 7), 16)) >>> 0;
};
const safeUrl = (url: unknown): string | undefined => {
  if (typeof url !== 'string' || url.length > 2048) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.href : undefined;
  } catch { return undefined; }
};
const mapStops = (stops: StopPayload[] | undefined): NamePaintStop[] =>
  (stops ?? []).slice(0, MAX_STOPS).flatMap(stop => {
    const color = colorArgb(stop.color);
    return color === null || !Number.isFinite(stop.at) ? [] :
      [{ at: Math.max(-5, Math.min(5, stop.at!)), color }];
  });

const mapLayer = (layer: PaintLayerPayload): NamePaintLayer | null => {
  const ty = layer.ty;
  if (!ty) return null;
  const opacity = Number.isFinite(layer.opacity)
    ? Math.max(0, Math.min(1, layer.opacity!)) : 1;
  switch (ty.__typename) {
    case 'PaintLayerTypeSingleColor': {
      const color = colorArgb(ty.color);
      return color === null ? null : { kind: 'solid', color, opacity };
    }
    case 'PaintLayerTypeLinearGradient': {
      const stops = mapStops(ty.stops);
      if (stops.length < 2) return null;
      return { kind: 'linear', angle: Number.isFinite(ty.angle) ? Math.max(-3600, Math.min(3600, ty.angle!)) : 0,
        repeating: ty.repeating === true, stops, opacity };
    }
    case 'PaintLayerTypeRadialGradient': {
      const stops = mapStops(ty.stops);
      if (stops.length < 2) return null;
      return { kind: 'radial', shape: ty.shape === 'CIRCLE' ? 'circle' : 'ellipse',
        repeating: ty.repeating === true, stops, opacity };
    }
    case 'PaintLayerTypeImage': {
      const images = ty.images ?? [];
      const image = images.find(candidate => candidate.scale === 1 && safeUrl(candidate.url)) ??
        images.find(candidate => safeUrl(candidate.url));
      const url = safeUrl(image?.url);
      return url ? { kind: 'image', url, opacity } : null;
    }
    default: return null;
  }
};
const mapShadows = (shadows: PaintDataPayload['shadows']): NamePaintShadow[] =>
  (shadows ?? []).slice(0, 8).flatMap(shadow => {
    const color = colorArgb(shadow.color);
    if (color === null || ![shadow.offsetX, shadow.offsetY, shadow.blur].every(Number.isFinite)) return [];
    return [{ xOffset: shadow.offsetX!, yOffset: shadow.offsetY!, radius: shadow.blur!, color }];
  });

const parseResponse = (response: PaintResponse): EnrichmentResult<NamePaint> => {
  if (response.errors?.length) return { value: null, ok: false,
    error: response.errors.map(error => error.message).filter(Boolean).join('; ') || '7TV v4 GraphQL error' };
  const connection = response.data?.users?.userByConnection;
  if (connection === undefined) return { value: null, ok: false, error: '7TV v4 response is missing user data' };
  if (!connection?.style?.activePaint?.id) return { value: null, ok: true };
  const id = connection.style.activePaint.id;
  const paint = connection.inventory?.paints?.find(item => item?.to?.paint?.id === id)?.to?.paint;
  if (!paint?.data || !Array.isArray(paint.data.layers)) {
    return { value: null, ok: false, error: '7TV v4 active paint was absent from inventory' };
  }
  const layers = paint.data.layers.slice(0, MAX_LAYERS)
    .map(mapLayer).filter((layer): layer is NamePaintLayer => layer !== null);
  if (paint.data.layers.length > 0 && layers.length === 0) {
    return { value: null, ok: false, error: '7TV v4 paint had no supported layers' };
  }
  return { ok: true, value: {
    id, provider: '7tv', name: paint.name, layers,
    shadows: mapShadows(paint.data.shadows),
  } };
};

export function clearSevenTvPaintV4Cache(twitchUserId?: string): void {
  if (twitchUserId) {
    cache.delete(twitchUserId);
    inFlight.delete(twitchUserId);
  } else {
    cache.clear();
    inFlight.clear();
  }
}
export function fetchSevenTvPaintV4Detailed(
  twitchUserId: string, options: IdentityFetchOptions = {},
): Promise<EnrichmentResult<NamePaint>> {
  const cached = cache.get(twitchUserId);
  if (!options.bypassCache && cached && cached.expiresAt > Date.now()) {
    return Promise.resolve({ value: cached.value, ok: true });
  }
  if (!options.bypassCache) {
    const current = inFlight.get(twitchUserId);
    if (current) return current;
  }
  const promise = (async (): Promise<EnrichmentResult<NamePaint>> => {
    try {
      const response = await fetchJson<PaintResponse>(V4_GQL, {
        method: 'POST', signal: options.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationName: 'ChatbusSevenTvPaint',
          query: QUERY, variables: { platformId: twitchUserId } }),
      });
      return parseResponse(response);
    } catch (error) {
      return { value: null, ok: false, error: error instanceof Error ? error.message : '7TV v4 request failed' };
    }
  })();
  inFlight.set(twitchUserId, promise);
  void promise.then(result => {
    if (inFlight.get(twitchUserId) !== promise) return;
    inFlight.delete(twitchUserId);
    const ttl = options.cacheTtlMs ?? DEFAULT_TTL_MS;
    if (result.ok && ttl > 0) cache.set(twitchUserId, { expiresAt: Date.now() + ttl, value: result.value });
  });
  return promise;
}