import type { ChatEvent } from '../../types/chat';
import { resolveTwitchChannel, resolveTwitchEventSubAuth } from './auth';
import { fetchTwitchCheermotes } from './cheermotes';
import { normalizeTwitchHypeTrainEvent } from './hypeTrain';
import { normalizeTwitchEventSubNotification } from './normalize';
import { listEnabledTwitchEventSubSubscriptions } from './reconcile';
import { createTwitchEventSubSocket } from './socket';
import {
  DEFAULT_TWITCH_CHAT_SUBSCRIPTIONS,
  createTwitchEventSubSubscription,
  subscribeTwitchChat,
  twitchSubscriptionMissingScopeRequirements,
} from './subscriptions';
import type {
  TwitchChatConnection,
  TwitchConnectOptions,
  TwitchEventSubEnvelope,
  TwitchEventSubSubscription,
  TwitchSubscriptionStateChange,
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
  const acceptNativeMessage = createMessageDeduper();
  const subscriptionState = new Map<string, TwitchEventSubSubscription>();
  let loadedCheermotes = options.cheermotes ?? options.getCheermotes?.() ?? {};

  const currentSubscriptions = (): TwitchEventSubSubscription[] => [...subscriptionState.values()];
  const currentCheermotes = () => options.getCheermotes?.() ?? loadedCheermotes;
  const reportSubscriptionState = (
    reason: TwitchSubscriptionStateChange['reason'],
    subscription?: TwitchEventSubSubscription,
  ) => {
    options.onSubscriptionStateChange?.({
      reason,
      subscriptions: currentSubscriptions(),
      ...(subscription ? { subscription } : {}),
    });
  };


  const auditIntervalMs = options.subscriptionReconcileIntervalMs ?? 5 * 60_000;
  if (!Number.isFinite(auditIntervalMs) || auditIntervalMs < 0 ||
      (auditIntervalMs > 0 && auditIntervalMs < 1_000)) {
    throw new RangeError('Twitch subscription reconciliation interval must be 0 or at least 1000ms');
  }
  const requestedTypes = [...new Set(requestedSubscriptions)];
  const requestController = new AbortController();
  const onAbortRequest = () => requestController.abort();
  options.signal?.addEventListener('abort', onAbortRequest, { once: true });
  let stopped = false;
  let sessionId: string | undefined;
  let socketConnected = false;
  let auditTimer: ReturnType<typeof setInterval> | undefined;
  let auditing = false;

  const replaceTracked = (type: string, entry?: TwitchEventSubSubscription): boolean => {
    const existing = currentSubscriptions().find((record) => record.type === type);
    if (existing && (!entry || existing.id !== entry.id)) {
      for (const [key, value] of subscriptionState) {
        if (value.type === type) subscriptionState.delete(key);
      }
    }
    if (entry && (!existing || existing.id !== entry.id)) {
      subscriptionState.set(subscriptionKey(entry), entry);
      return true;
    }
    return Boolean(existing && !entry);
  };

  const reconcile = async () => {
    if (stopped || auditing || !socketConnected || !sessionId) return;
    auditing = true;
    const auditedSession = sessionId;
    const isCurrent = () => !stopped && socketConnected && sessionId === auditedSession &&
      !requestController.signal.aborted;
    try {
      const all = await listEnabledTwitchEventSubSubscriptions(auth, requestController.signal);
      if (!isCurrent()) return;
      // The Twitch GET endpoint lists all enabled subscriptions for the token,
      // not just the current WebSocket. Never use another session as proof.
      const active = all.filter((record) =>
        record.status === 'enabled' &&
        record.transport?.session_id === auditedSession &&
        record.condition?.broadcaster_user_id === channel.id);
      const missing = requestedTypes.filter((type) => !active.some((record) => record.type === type));
      let changed = false;
      for (const type of requestedTypes) {
        const actual = active.find((record) => record.type === type);
        changed = replaceTracked(type, actual) || changed;
      }
      if (missing.length > 0) {
        reportSubscriptionState('degraded');
      } else if (changed) {
        reportSubscriptionState('repaired');
      }

      let repaired = false;
      for (const type of missing) {
        if (!isCurrent()) return;
        try {
          const created = await createTwitchEventSubSubscription(
            type, auditedSession, channel.id, auth, requestController.signal,
          );
          if (!isCurrent()) return;
          if (!created || created.type !== type || (created.status && created.status !== 'enabled')) {
            throw new Error(`Twitch EventSub repair did not confirm an enabled ${type} subscription`);
          }
          replaceTracked(type, created);
          repaired = true;
        } catch (error) {
          if (!isCurrent()) return;
          options.onError?.(error instanceof Error ? error : new Error('Twitch EventSub repair failed'));
        }
      }
      if (repaired && isCurrent()) reportSubscriptionState('repaired');
    } catch (error) {
      if (isCurrent()) {
        options.onError?.(error instanceof Error ? error : new Error('Twitch subscription inspection failed'));
      }
    } finally {
      auditing = false;
    }
  };

  const startAudit = () => {
    if (auditIntervalMs > 0 && auditTimer === undefined && !stopped) {
      auditTimer = setInterval(() => { void reconcile(); }, auditIntervalMs);
    }
  };

  const stopAudit = () => {
    stopped = true;
    socketConnected = false;
    requestController.abort();
    options.signal?.removeEventListener('abort', onAbortRequest);
    if (auditTimer !== undefined) {
      clearInterval(auditTimer);
      auditTimer = undefined;
    }
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
    // Envelope IDs only suppress retries of the same EventSub delivery. A
    // notice and channel.chat.message can carry different envelope IDs for
    // the very same native message. Suppress those before notifying consumers.
    if (event?.message?.id && !acceptNativeMessage(
      `${event.platform}:${event.channelId ?? channel.id}:${event.message.id}`,
    )) return;
    // This connector receives from authenticated live EventSub. Pure
    // normalizers remain replay-safe and do not invent live provenance.
    if (event) options.onEvent({ ...event, origin: 'live' });
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
      origin: 'live',
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
    onStateChange: (state) => {
      socketConnected = state === 'connected';
      options.onStateChange?.(state);
    },
    onError: options.onError,
    onNotification: handleNotification,
    onRevocation: handleRevocation,
    onWelcome: async (session, { isServerReconnect }) => {
      sessionId = session.id;
      if (isServerReconnect) return;
      subscriptionState.clear();
      const subscriptions = await subscribeTwitchChat(session.id, channel.id, auth, {
        subscriptions: requestedSubscriptions,
        signal: requestController.signal,
      });
      if (stopped || requestController.signal.aborted) return;
      // A WebSocket with zero active subscriptions is not a healthy chat
      // connection; Twitch will close it shortly after welcome. Reconnect
      // instead of telling consumers it is fully subscribed.
      if (subscriptions.length === 0) {
        throw new Error('Twitch EventSub welcome created no active subscriptions');
      }
      for (const subscription of subscriptions) {
        subscriptionState.set(subscriptionKey(subscription), subscription);
      }
      reportSubscriptionState('subscribed');
      startAudit();
    },
  });

  const abort = () => {
    stopAudit();
    socket.close();
  };
  options.signal?.addEventListener('abort', abort, { once: true });

  return {
    auth,
    channel,
    subscriptions: currentSubscriptions,
    cheermotes: currentCheermotes,
    close: () => {
      options.signal?.removeEventListener('abort', abort);
      stopAudit();
      socket.close();
    },
  };
}
