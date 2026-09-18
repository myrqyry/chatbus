import { fetchWithTimeout } from '../../network/fetch';
import type {
  TwitchAuth,
  TwitchChatSubscriptionType,
  TwitchEventSubSubscription,
  TwitchEventSubSubscriptionType,
  TwitchFollowerSubscriptionType,
  TwitchHypeTrainSubscriptionType,
  TwitchModerationSubscriptionType,
  TwitchRewardSubscriptionType,
  TwitchStateSubscriptionType,
} from './types';

export const DEFAULT_TWITCH_CHAT_SUBSCRIPTIONS: TwitchChatSubscriptionType[] = [
  'channel.chat.message',
  'channel.chat.message_delete',
  'channel.chat.notification',
  'channel.chat_settings.update',
  'channel.chat.clear',
  'channel.chat.clear_user_messages',
];

export const TWITCH_HYPE_TRAIN_SUBSCRIPTIONS: TwitchHypeTrainSubscriptionType[] = [
  'channel.hype_train.begin',
  'channel.hype_train.progress',
  'channel.hype_train.end',
];

export const TWITCH_STATE_SUBSCRIPTIONS: TwitchStateSubscriptionType[] = [
  'channel.update',
  'stream.online',
  'stream.offline',
];

export const TWITCH_FOLLOW_SUBSCRIPTIONS: TwitchFollowerSubscriptionType[] = ['channel.follow'];
export const TWITCH_REWARD_SUBSCRIPTIONS: TwitchRewardSubscriptionType[] = [
  'channel.channel_points_custom_reward_redemption.add',
];
export const TWITCH_MODERATION_SUBSCRIPTIONS: TwitchModerationSubscriptionType[] = ['channel.ban'];

const HYPE_TRAIN_SUBSCRIPTIONS = new Set<TwitchEventSubSubscriptionType>(TWITCH_HYPE_TRAIN_SUBSCRIPTIONS);
const CHAT_SUBSCRIPTIONS = new Set<TwitchEventSubSubscriptionType>(DEFAULT_TWITCH_CHAT_SUBSCRIPTIONS);
const FOLLOW_SUBSCRIPTIONS = new Set<TwitchEventSubSubscriptionType>(TWITCH_FOLLOW_SUBSCRIPTIONS);

const versionFor = (type: TwitchEventSubSubscriptionType): string => {
  if (HYPE_TRAIN_SUBSCRIPTIONS.has(type) || type === 'channel.update' || type === 'channel.follow') return '2';
  return '1';
};

const conditionFor = (
  type: TwitchEventSubSubscriptionType,
  broadcasterUserId: string,
  auth: TwitchAuth,
): Record<string, string> => {
  if (CHAT_SUBSCRIPTIONS.has(type)) {
    return { broadcaster_user_id: broadcasterUserId, user_id: auth.userId };
  }
  if (FOLLOW_SUBSCRIPTIONS.has(type)) {
    return { broadcaster_user_id: broadcasterUserId, moderator_user_id: auth.userId };
  }
  return { broadcaster_user_id: broadcasterUserId };
};

const scopeRequirementsFor = (type: TwitchEventSubSubscriptionType): readonly (readonly string[])[] => {
  if (HYPE_TRAIN_SUBSCRIPTIONS.has(type)) return [['channel:read:hype_train']];
  if (FOLLOW_SUBSCRIPTIONS.has(type)) return [['moderator:read:followers']];
  if (type === 'channel.channel_points_custom_reward_redemption.add') {
    return [['channel:read:redemptions', 'channel:manage:redemptions']];
  }
  if (type === 'channel.ban') return [['channel:moderate']];
  return [];
};

const groupKey = (group: readonly string[]): string => [...group].sort().join('\u0000');

export const twitchSubscriptionScopeRequirements = (
  subscriptions: Iterable<TwitchEventSubSubscriptionType>,
): string[][] => {
  const seen = new Set<string>();
  const result: string[][] = [];
  for (const type of subscriptions) {
    for (const group of scopeRequirementsFor(type)) {
      const key = groupKey(group);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push([...group]);
    }
  }
  return result;
};

/** Compatibility helper returning one suggested scope per required OR-group. */
export const twitchSubscriptionRequiredScopes = (
  subscriptions: Iterable<TwitchEventSubSubscriptionType>,
): string[] => twitchSubscriptionScopeRequirements(subscriptions).flatMap((group) => group[0] ? [group[0]] : []);

export const twitchSubscriptionMissingScopeRequirements = (
  subscriptions: Iterable<TwitchEventSubSubscriptionType>,
  grantedScopes: Iterable<string>,
): string[][] => {
  const granted = new Set(grantedScopes);
  return twitchSubscriptionScopeRequirements(subscriptions)
    .filter((group) => !group.some((scope) => granted.has(scope)));
};

export async function createTwitchEventSubSubscription(
  type: TwitchEventSubSubscriptionType,
  sessionId: string,
  broadcasterUserId: string,
  auth: TwitchAuth,
  signal?: AbortSignal,
): Promise<TwitchEventSubSubscription | null> {
  const response = await fetchWithTimeout(
    'https://api.twitch.tv/helix/eventsub/subscriptions',
    {
      method: 'POST',
      headers: {
        'Client-Id': auth.clientId,
        Authorization: `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type,
        version: versionFor(type),
        condition: conditionFor(type, broadcasterUserId, auth),
        transport: {
          method: 'websocket',
          session_id: sessionId,
        },
      }),
      signal,
    },
    5_000,
    0,
  );

  let body: { data?: TwitchEventSubSubscription[]; message?: string } | undefined;
  try {
    body = await response.json() as { data?: TwitchEventSubSubscription[]; message?: string };
  } catch {
    // Twitch normally returns JSON, but status is sufficient if it does not.
  }

  if (!response.ok) {
    const detail = body?.message ? `: ${body.message}` : '';
    throw new Error(`Twitch EventSub subscription ${type} failed with ${response.status}${detail}`);
  }

  return body?.data?.[0] ?? null;
}

export async function subscribeTwitchChat(
  sessionId: string,
  broadcasterUserId: string,
  auth: TwitchAuth,
  options: {
    subscriptions?: TwitchEventSubSubscriptionType[];
    signal?: AbortSignal;
  } = {},
): Promise<TwitchEventSubSubscription[]> {
  const subscriptions = options.subscriptions ?? DEFAULT_TWITCH_CHAT_SUBSCRIPTIONS;
  const created = await Promise.all(subscriptions.map((type) =>
    createTwitchEventSubSubscription(type, sessionId, broadcasterUserId, auth, options.signal)));
  return created.filter((subscription): subscription is TwitchEventSubSubscription => subscription !== null);
}
