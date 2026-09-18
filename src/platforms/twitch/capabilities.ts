import type { ChatEventType } from '../../types/chat';

export type TwitchCapabilityId =
  | 'chat'
  | 'channel-state'
  | 'stream-state'
  | 'hype-train'
  | 'followers'
  | 'rewards'
  | 'moderation';

export type TwitchEventSubConditionKind = 'chat-user' | 'broadcaster' | 'moderator';

/**
 * Each requirement is an OR-group. Every group on a subscription must be
 * satisfied, but any one scope inside a group is enough.
 */
export interface TwitchScopeRequirement {
  anyOf: readonly string[];
  description?: string;
}

export interface TwitchCapabilitySubscriptionDefinition {
  type: string;
  version: string;
  condition: TwitchEventSubConditionKind;
  scopeRequirements: readonly TwitchScopeRequirement[];
  /** ChatEvent types currently emitted by Chatbus for this subscription. */
  normalizedEventTypes?: readonly ChatEventType[];
}

export interface TwitchCapabilityDefinition {
  id: TwitchCapabilityId;
  description: string;
  subscriptions: readonly TwitchCapabilitySubscriptionDefinition[];
}

export interface TwitchCapabilityPlanOptions {
  broadcasterUserId: string;
  userId: string;
  scopes?: Iterable<string>;
}

export interface TwitchPlannedSubscription extends TwitchCapabilitySubscriptionDefinition {
  capability: TwitchCapabilityId;
  conditionValues: Record<string, string>;
  ready: boolean;
  missingScopeRequirements: TwitchScopeRequirement[];
  handledByChatbus: boolean;
  /** @deprecated Use handledByChatbus. Preserved for compatibility with pre-rename consumers. */
  handledByChatCore: boolean;
}

export interface TwitchCapabilityStatus {
  id: TwitchCapabilityId;
  ready: boolean;
  partial: boolean;
  subscriptions: TwitchPlannedSubscription[];
  missingScopeRequirements: TwitchScopeRequirement[];
}

export interface TwitchCapabilityPlan {
  requested: TwitchCapabilityId[];
  capabilities: TwitchCapabilityStatus[];
  subscriptions: TwitchPlannedSubscription[];
  missingScopeRequirements: TwitchScopeRequirement[];
  /** One valid scope choice from each missing OR-group, useful when building an OAuth request. */
  suggestedScopes: string[];
}

const scope = (...anyOf: string[]): TwitchScopeRequirement => ({ anyOf });

const CHAT_SCOPE = scope('user:read:chat');
const HYPE_TRAIN_SCOPE = scope('channel:read:hype_train');

const chatSubscription = (
  type: string,
  normalizedEventTypes: readonly ChatEventType[],
): TwitchCapabilitySubscriptionDefinition => ({
  type,
  version: '1',
  condition: 'chat-user',
  scopeRequirements: [CHAT_SCOPE],
  normalizedEventTypes,
});

const hypeTrainSubscription = (
  type: 'channel.hype_train.begin' | 'channel.hype_train.progress' | 'channel.hype_train.end',
): TwitchCapabilitySubscriptionDefinition => ({
  type,
  version: '2',
  condition: 'broadcaster',
  scopeRequirements: [HYPE_TRAIN_SCOPE],
  normalizedEventTypes: ['hype-train'],
});

export const TWITCH_CAPABILITY_REGISTRY: Readonly<Record<TwitchCapabilityId, TwitchCapabilityDefinition>> = {
  chat: {
    id: 'chat',
    description: 'Read Twitch chat and the chat-native notices used by overlays.',
    subscriptions: [
      chatSubscription('channel.chat.message', ['message', 'cheer']),
      chatSubscription('channel.chat.message_delete', ['message-delete']),
      chatSubscription('channel.chat.notification', ['subscription', 'gift-subscription', 'raid', 'system']),
      chatSubscription('channel.chat_settings.update', ['room-state']),
      chatSubscription('channel.chat.clear', ['system']),
      chatSubscription('channel.chat.clear_user_messages', ['system']),
    ],
  },
  'channel-state': {
    id: 'channel-state',
    description: 'Observe broadcaster title, category, language, and content-classification changes.',
    subscriptions: [{
      type: 'channel.update',
      version: '2',
      condition: 'broadcaster',
      scopeRequirements: [],
      normalizedEventTypes: ['channel-update'],
    }],
  },
  'stream-state': {
    id: 'stream-state',
    description: 'Observe stream online/offline transitions.',
    subscriptions: [
      {
        type: 'stream.online',
        version: '1',
        condition: 'broadcaster',
        scopeRequirements: [],
        normalizedEventTypes: ['stream-online'],
      },
      {
        type: 'stream.offline',
        version: '1',
        condition: 'broadcaster',
        scopeRequirements: [],
        normalizedEventTypes: ['stream-offline'],
      },
    ],
  },
  'hype-train': {
    id: 'hype-train',
    description: 'Observe Twitch Hype Train begin, progress, and end events.',
    subscriptions: [
      hypeTrainSubscription('channel.hype_train.begin'),
      hypeTrainSubscription('channel.hype_train.progress'),
      hypeTrainSubscription('channel.hype_train.end'),
    ],
  },
  followers: {
    id: 'followers',
    description: 'Observe new followers when the authenticated user is an eligible moderator or broadcaster.',
    subscriptions: [{
      type: 'channel.follow',
      version: '2',
      condition: 'moderator',
      scopeRequirements: [scope('moderator:read:followers')],
      normalizedEventTypes: ['follow'],
    }],
  },
  rewards: {
    id: 'rewards',
    description: 'Observe custom Channel Points reward redemptions.',
    subscriptions: [{
      type: 'channel.channel_points_custom_reward_redemption.add',
      version: '1',
      condition: 'broadcaster',
      scopeRequirements: [scope('channel:read:redemptions', 'channel:manage:redemptions')],
      normalizedEventTypes: ['reward-redemption'],
    }],
  },
  moderation: {
    id: 'moderation',
    description: 'Observe bans/timeouts and detailed moderator actions without broadening normal chat auth.',
    subscriptions: [
      {
        type: 'channel.ban',
        version: '1',
        condition: 'broadcaster',
        scopeRequirements: [scope('channel:moderate')],
        normalizedEventTypes: ['user-ban', 'user-timeout'],
      },
      {
        type: 'channel.moderate',
        version: '2',
        condition: 'moderator',
        scopeRequirements: [
          scope('moderator:read:blocked_terms', 'moderator:manage:blocked_terms'),
          scope('moderator:read:chat_settings', 'moderator:manage:chat_settings'),
          scope('moderator:read:unban_requests', 'moderator:manage:unban_requests'),
          scope('moderator:read:banned_users', 'moderator:manage:banned_users'),
          scope('moderator:read:chat_messages', 'moderator:manage:chat_messages'),
          scope('moderator:read:warnings', 'moderator:manage:warnings'),
          scope('moderator:read:moderators'),
          scope('moderator:read:vips'),
        ],
      },
    ],
  },
};

const conditionValues = (
  kind: TwitchEventSubConditionKind,
  broadcasterUserId: string,
  userId: string,
): Record<string, string> => {
  if (kind === 'chat-user') {
    return { broadcaster_user_id: broadcasterUserId, user_id: userId };
  }
  if (kind === 'moderator') {
    return { broadcaster_user_id: broadcasterUserId, moderator_user_id: userId };
  }
  return { broadcaster_user_id: broadcasterUserId };
};

const missingRequirements = (
  requirements: readonly TwitchScopeRequirement[],
  scopes: ReadonlySet<string>,
): TwitchScopeRequirement[] => requirements.filter((requirement) =>
  !requirement.anyOf.some((candidate) => scopes.has(candidate)));

const requirementKey = (requirement: TwitchScopeRequirement): string =>
  [...requirement.anyOf].sort().join('\u0000');

const uniqueRequirements = (requirements: TwitchScopeRequirement[]): TwitchScopeRequirement[] => {
  const seen = new Set<string>();
  return requirements.filter((requirement) => {
    const key = requirementKey(requirement);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export function planTwitchCapabilities(
  requested: Iterable<TwitchCapabilityId>,
  options: TwitchCapabilityPlanOptions,
): TwitchCapabilityPlan {
  const broadcasterUserId = options.broadcasterUserId.trim();
  const userId = options.userId.trim();
  if (!broadcasterUserId) throw new Error('Twitch capability planning requires broadcasterUserId');
  if (!userId) throw new Error('Twitch capability planning requires userId');

  const requestedIds = [...new Set(requested)];
  const grantedScopes = new Set(options.scopes ?? []);
  const subscriptions: TwitchPlannedSubscription[] = requestedIds.flatMap((id) => {
    const capability = TWITCH_CAPABILITY_REGISTRY[id];
    return capability.subscriptions.map((definition): TwitchPlannedSubscription => {
      const missing = missingRequirements(definition.scopeRequirements, grantedScopes);
      return {
        ...definition,
        capability: id,
        conditionValues: conditionValues(definition.condition, broadcasterUserId, userId),
        ready: missing.length === 0,
        missingScopeRequirements: missing,
        handledByChatbus: Boolean(definition.normalizedEventTypes?.length),
        handledByChatCore: Boolean(definition.normalizedEventTypes?.length),
      };
    });
  });

  const capabilities = requestedIds.map((id): TwitchCapabilityStatus => {
    const items = subscriptions.filter((subscription) => subscription.capability === id);
    const readyCount = items.filter((subscription) => subscription.ready).length;
    return {
      id,
      ready: items.length > 0 && readyCount === items.length,
      partial: readyCount > 0 && readyCount < items.length,
      subscriptions: items,
      missingScopeRequirements: uniqueRequirements(items.flatMap((item) => item.missingScopeRequirements)),
    };
  });

  const missingScopeRequirements = uniqueRequirements(
    subscriptions.flatMap((subscription) => subscription.missingScopeRequirements),
  );

  return {
    requested: requestedIds,
    capabilities,
    subscriptions,
    missingScopeRequirements,
    suggestedScopes: missingScopeRequirements.flatMap((requirement) => requirement.anyOf[0] ? [requirement.anyOf[0]] : []),
  };
}
