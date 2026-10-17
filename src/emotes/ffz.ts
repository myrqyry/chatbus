import type { EmoteCandidate, EmoteImage, EmoteModifier } from '../types/emotes';
import type { ProviderOptions, ProviderResult } from '../types/providers';
import { fetchJson, HttpError } from '../network/fetch';
import { providerStatus } from '../types/providers';

interface FfzEmote {
  id?: number;
  name?: string;
  urls?: Record<string, string>;
  modifier?: boolean;
  modifier_flags?: number;
  width?: number;
  height?: number;
}
interface FfzSet { emoticons?: FfzEmote[]; }
interface FfzResponse { sets?: Record<string, FfzSet>; }

const normalizeUrl = (url: string): string => url.startsWith('//') ? `https:${url}` : url;

const imagesFrom = (emote: FfzEmote): EmoteImage[] => Object.entries(emote.urls ?? {})
  .sort(([a], [b]) => Number(a) - Number(b))
  .map(([scale, url]) => ({
    url: normalizeUrl(url),
    scale: Number(scale) || undefined,
    width: emote.width && Number(scale) ? emote.width * Number(scale) : emote.width,
    height: emote.height && Number(scale) ? emote.height * Number(scale) : emote.height,
  }));

const modifierFrom = (emote: FfzEmote): EmoteModifier | undefined => {
  if (!emote.modifier) return undefined;
  return ((emote.modifier_flags ?? 0) & 1) !== 0 ? 'hidden' : 'overlay';
};

const candidatesFrom = (data: FfzResponse, scope: 'channel' | 'global'): EmoteCandidate[] =>
  Object.values(data.sets ?? {}).flatMap((set) => (set.emoticons ?? []).flatMap((emote) => {
    const id = emote.id;
    const code = emote.name;
    const images = imagesFrom(emote);
    const primary = images.at(-1);
    if (id == null || !code || !primary) return [];
    const modifier = modifierFrom(emote);
    return [{
      id: String(id),
      code,
      url: primary.url,
      altUrls: images.slice(0, -1).map((image) => image.url),
      zeroWidth: modifier === 'overlay',
      provider: 'ffz' as const,
      scope,
      images,
      ...(modifier ? { modifier, modifierFlags: Number.isSafeInteger(emote.modifier_flags) && (emote.modifier_flags ?? 0) >= 0 ? emote.modifier_flags : 0 } : {}),
      raw: emote,
    }];
  }));

async function load(
  url: string,
  scope: 'channel' | 'global',
  options: ProviderOptions,
  notFoundIsEmpty = false,
): Promise<ProviderResult> {
  try {
    const candidates = candidatesFrom(await fetchJson<FfzResponse>(url, { signal: options.signal }), scope);
    return { candidates, status: providerStatus('ffz', scope, candidates) };
  } catch (error) {
    if (notFoundIsEmpty && error instanceof HttpError && error.status === 404) {
      return { candidates: [], status: providerStatus('ffz', scope, []) };
    }
    return { candidates: [], status: providerStatus('ffz', scope, [], error) };
  }
}

export const fetchGlobalFfz = (options: ProviderOptions = {}): Promise<ProviderResult> =>
  load('https://api.frankerfacez.com/v1/set/global', 'global', options);

export const fetchChannelFfz = (channelName: string, options: ProviderOptions = {}): Promise<ProviderResult> =>
  load(`https://api.frankerfacez.com/v1/room/${encodeURIComponent(channelName)}`, 'channel', options, true);
