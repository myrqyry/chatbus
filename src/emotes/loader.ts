import type { EmoteFetchOptions, EmoteFetchResult, EmoteSet, ProviderStatus } from '../types/emotes';
import type { ProviderResult } from '../types/providers';
import { providerStatus } from '../types/providers';
import { isAbortError } from '../network/fetch';
import { fetchChannelSevenTv, fetchGlobalSevenTv } from './sevenTv';
import { fetchChannelBttv, fetchGlobalBttv } from './bttv';
import { fetchChannelFfz, fetchGlobalFfz } from './ffz';
import { resolveTwitchUserIdDetailed } from './twitch';
import { mergeCandidates } from './registry';
import { readCachedEmotes, writeCachedEmotes } from './cache';

const inflight = new Map<string, Promise<EmoteFetchResult>>();

const trackRequest = (channel: string, request: Promise<EmoteFetchResult>): Promise<EmoteFetchResult> => {
  inflight.set(channel, request);
  request.finally(() => {
    if (inflight.get(channel) === request) inflight.delete(channel);
  }).catch(() => undefined);
  return request;
};

const abortable = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
};

const failedBttvLookup = (error?: string): ProviderResult => ({
  candidates: [],
  status: providerStatus(
    'bttv',
    'channel',
    [],
    new Error(error ? `Twitch user lookup failed: ${error}` : 'Twitch user lookup failed'),
  ),
});

const load = async (channel: string): Promise<EmoteFetchResult> => {
  const globalResultsPromise = Promise.all([
    fetchGlobalSevenTv(),
    fetchGlobalBttv(),
    fetchGlobalFfz(),
  ]);
  const userResolutionPromise = resolveTwitchUserIdDetailed(channel);

  const [globalResults, userResolution] = await Promise.all([
    globalResultsPromise,
    userResolutionPromise,
  ]);

  const channelResults = await Promise.all([
    fetchChannelSevenTv(channel, userResolution.id),
    userResolution.ok ? fetchChannelBttv(userResolution.id) : Promise.resolve(failedBttvLookup(userResolution.error)),
    fetchChannelFfz(channel),
  ]);
  const results = [...globalResults, ...channelResults];
  const providers: ProviderStatus[] = results.map((result) => result.status);
  const candidates = results.flatMap((result) => result.candidates);
  const emotes: EmoteSet = mergeCandidates(candidates);
  const result: EmoteFetchResult = {
    emotes,
    candidates,
    providers,
    fromCache: false,
    complete: providers.every((status) => status.ok),
  };

  // A degraded result is useful to the current caller, but caching it would
  // prevent later calls from retrying the provider that failed for the full
  // cache lifetime. Only complete snapshots become reusable cache entries.
  if (result.complete) writeCachedEmotes(channel, result);
  return result;
};

export const fetchChannelEmotesDetailed = async (
  channelName: string,
  options: EmoteFetchOptions = {},
): Promise<EmoteFetchResult> => {
  const channel = channelName.trim().toLowerCase();
  if (!channel) return { emotes: {}, candidates: [], providers: [], fromCache: false, complete: true };

  if (!options.bypassCache) {
    const cached = readCachedEmotes(channel);
    const missingCandidates = cached !== null &&
      cached.candidates === undefined && Object.keys(cached.emotes).length > 0;
    if (cached && !missingCandidates) return abortable(Promise.resolve(cached), options.signal);

    const current = inflight.get(channel);
    if (current) return abortable(current, options.signal);

    if (cached && missingCandidates) {
      // Older cache snapshots retained the winning emotes but not their scopes.
      // Refresh once for shared consumers; only replace the usable old snapshot
      // when ALL providers succeed and candidate metadata belongs to that snapshot.
      const recovery = load(channel).then(
        (fresh) => fresh.complete && fresh.candidates !== undefined ? fresh : cached,
        () => cached,
      );
      return abortable(trackRequest(channel, recovery), options.signal);
    }
  }

  return abortable(trackRequest(channel, load(channel)), options.signal);
};

export const fetchChannelEmotes = async (
  channelName: string,
  options: EmoteFetchOptions = {},
): Promise<EmoteSet> => (await fetchChannelEmotesDetailed(channelName, options)).emotes;

export { isAbortError };
