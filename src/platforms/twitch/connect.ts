import type { ChatEvent } from '../../types/chat';
import { resolveTwitchChannel, resolveTwitchEventSubAuth } from './auth';
import { fetchTwitchCheermotes } from './cheermotes';
import { normalizeTwitchHypeTrainEvent } from './hypeTrain';
import { normalizeTwitchEventSubNotification } from './normalize';
import { createTwitchEventSubSocket } from './socket';
import {
  DEFAULT_TWITCH_CHAT_SUBSCRIPTIONS,
  subscribeTwitchChat,
  twitchSubscriptionMissingScopeRequirements,
} from './subscriptions';
import type {
  TwitchChatConnection,
  TwitchConnectOptions,
  TwitchEventSubEnvelope,
  TwitchEventSubSubscription,
} from './types';

const DEDUPE_TTL_MS = 10 * 60 * 1000;
const DEDUPE_MAX = 2_000;

const createMessageDeduper = () => {
  const seen = new Map<string, number>();
  return (id: string): boolean => {
    const now = Date.now();
    for (const [key, timestamp] of seen) {
      if (now - timestamp <= DEDUPE_TTL_MS) break;
      seen.delete(key);
    }
    if (seen.has(id)) return false;
    seen.set(id, now);
    while (seen.size > DEDUPE_MAX) {
      const oldest = seen.keys().next().value as string | undefined;
      if (!oldest) break;
      seen.delete(oldest);
    }
    return true;
  };
};

const subscriptionKey = (subscription: TwitchEventSubSubscription): string =>
  subscription.id ?? `${subscription.type}:${subscription.version ?? ''}`;

export async function connectTwitchChat(options: TwitchConnectOptions): Promise<TwitchChatConnection> {
  const channelName = options.channel.trim().replace(/^#/u, '');
  if (!channelName) throw new Error('Twitch channel name must not be empty');
  if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');

  const requestedSubscriptions = options.subscriptions ?? DEFAULT_TWITCH_CHAT_SUBSCRIPTIONS;
  const auth = await resolveTwitchEventSubAuth(options.accessToken, {
    clientId: options.clientId,
    userId: options.userId,
    signal: options.signal,
  });
  const missingScopeRequirements = twitchSubscriptionMissingScopeRequirements(
    requestedSubscriptions,
    auth.scopes ?? [],
  );
  if (missingScopeRequirements.length > 0) {
    const descriptions = missingScopeRequirements.map((group) => group.join(' or '));
    throw new Error(`Twitch user access token is missing required scope${descriptions.length === 1 ? '' : ' groups'}: ${descriptions.join(', ')}`);
  }

  const channel = options.broadcasterUserId
    ? { id: options.broadcasterUserId, login: channelName.toLowerCase() }
    : await resolveTwitchChannel(channelName, auth, options.signal);

  const acceptMessage = createMessageDeduper();
  const subscriptionState = new Map<string, TwitchEventSubSubscription>();
  let loadedCheermotes = options.cheermotes ?? options.getCheermotes?.() ?? {};

  const currentSubscriptions = (): TwitchEventSubSubscription[] => [...subscriptionState.values()];
  const currentCheermotes = () => options.getCheermotes?.() ?? loadedCheermotes;
  const reportSubscriptionState = (
    reason: 'subscribed' | 'revoked',
    subscription?: TwitchEventSubSubscription,
  ) => {
    options.onSubscriptionStateChange?.({
      reason,
      subscriptions: currentSubscriptions(),
      ...(subscription ? { subscription } : {}),
    });
  };

  if (!options.cheermotes && !options.getCheermotes && options.loadCheermotes !== false) {
    void fetchTwitchCheermotes(auth, channel.id, options.signal)
      .then((cheermotes) => {
        if (options.signal?.aborted) return;
        loadedCheermotes = cheermotes;
        options.onCheermotesLoaded?.(cheermotes);
      })
      .catch((error) => {
        if (options.signal?.aborted) return;
        options.onError?.(error instanceof Error ? error : new Error('Twitch Cheermote enrichment failed'));
      });
  }

  const handleNotification = (envelope: TwitchEventSubEnvelope) => {
    if (!acceptMessage(envelope.metadata.message_id)) return;
    const context = {
      emotes: options.getEmotes?.() ?? options.emotes,
      getUserEmotes: options.getUserEmotes,
      cheermotes: currentCheermotes(),
    };
    const event = normalizeTwitchEventSubNotification(envelope, context)
      ?? normalizeTwitchHypeTrainEvent(envelope, context);
    if (event) options.onEvent(event);
  };

  const handleRevocation = (envelope: TwitchEventSubEnvelope) => {
    if (!acceptMessage(envelope.metadata.message_id)) return;
    const subscription = envelope.payload.subscription;
    if (subscription) {
      if (subscription.id) {
        subscriptionState.delete(subscription.id);
      } else {
        for (const [key, existing] of subscriptionState) {
          if (existing.type === subscription.type) subscriptionState.delete(key);
        }
      }
      reportSubscriptionState('revoked', subscription);
    }

    const event: ChatEvent = {
      id: envelope.metadata.message_id,
      type: 'system',
      platform: 'twitch',
      channelId: channel.id,
      channelName: channel.login,
      timestamp: Date.now(),
      data: {
        kind: 'eventsub-revocation',
        subscriptionId: subscription?.id,
        subscriptionType: subscription?.type,
        version: subscription?.version,
        status: subscription?.status,
      },
      raw: envelope,
    };
    options.onEvent(event);
  };

  const socket = createTwitchEventSubSocket({
    ...options.socket,
    onStateChange: options.onStateChange,
    onError: options.onError,
    onNotification: handleNotification,
    onRevocation: handleRevocation,
    onWelcome: async (session, { isServerReconnect }) => {
      if (isServerReconnect) return;
      subscriptionState.clear();
      const subscriptions = await subscribeTwitchChat(session.id, channel.id, auth, {
        subscriptions: requestedSubscriptions,
        signal: options.signal,
      });
      for (const subscription of subscriptions) {
        subscriptionState.set(subscriptionKey(subscription), subscription);
      }
      reportSubscriptionState('subscribed');
    },
  });

  const abort = () => socket.close();
  options.signal?.addEventListener('abort', abort, { once: true });

  return {
    auth,
    channel,
    subscriptions: currentSubscriptions,
    cheermotes: currentCheermotes,
    close: () => {
      options.signal?.removeEventListener('abort', abort);
      socket.close();
    },
  };
}
