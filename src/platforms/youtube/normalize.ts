import { parseMessageFragments } from '../../messages/parse';
import type { ChatEvent, ChatMessage, ChatUser } from '../../types/chat';
import type { BadgeRef } from '../../types/identity';
import type {
  YouTubeLiveChatAuthorDetails,
  YouTubeLiveChatMessageResource,
  YouTubeNormalizeContext,
} from './types';

const timestampFrom = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const badgeRefsFrom = (author: YouTubeLiveChatAuthorDetails | undefined): BadgeRef[] | undefined => {
  if (!author) return undefined;
  const refs: BadgeRef[] = [];
  if (author.isChatOwner) refs.push({ id: 'owner', provider: 'youtube' });
  if (author.isChatModerator) refs.push({ id: 'moderator', provider: 'youtube' });
  if (author.isChatSponsor) refs.push({ id: 'member', provider: 'youtube' });
  if (author.isVerified) refs.push({ id: 'verified', provider: 'youtube' });
  return refs.length ? refs : undefined;
};

const userFromAuthor = (
  author: YouTubeLiveChatAuthorDetails | undefined,
  fallbackChannelId?: string,
): ChatUser | undefined => {
  const username = author?.displayName?.trim();
  if (!username) return undefined;
  const badgeRefs = badgeRefsFrom(author);
  return {
    platform: 'youtube',
    id: author?.channelId ?? fallbackChannelId,
    username,
    displayName: username,
    roles: badgeRefs?.map((badge) => badge.id),
    badgeRefs,
    raw: author,
  };
};

const messageFrom = (
  resource: YouTubeLiveChatMessageResource,
  context: YouTubeNormalizeContext,
  user: ChatUser | undefined,
  timestamp: number,
  fallbackText?: string,
): ChatMessage | undefined => {
  if (!user) return undefined;
  const snippet = resource.snippet;
  const text = snippet?.displayMessage
    ?? snippet?.textMessageDetails?.messageText
    ?? fallbackText
    ?? '';
  if (!text) return undefined;
  return {
    id: resource.id,
    platform: 'youtube',
    channelId: context.channelId,
    channelName: context.channelName,
    user,
    text,
    fragments: parseMessageFragments(text),
    timestamp,
    raw: resource,
  };
};

const baseEvent = (
  resource: YouTubeLiveChatMessageResource,
  context: YouTubeNormalizeContext,
  timestamp: number,
) => ({
  id: resource.id,
  platform: 'youtube' as const,
  channelId: context.channelId,
  channelName: context.channelName,
  timestamp,
  origin: 'live' as const,
  raw: resource,
});

export function normalizeYouTubeLiveChatMessage(
  resource: YouTubeLiveChatMessageResource,
  context: YouTubeNormalizeContext = {},
): ChatEvent | null {
  const snippet = resource.snippet;
  if (!resource.id || !snippet?.type) return null;
  const now = context.now?.() ?? Date.now();
  const timestamp = timestampFrom(snippet.publishedAt, now);
  const user = userFromAuthor(resource.authorDetails, snippet.authorChannelId);
  const base = baseEvent(resource, context, timestamp);

  if (snippet.type === 'textMessageEvent') {
    const message = messageFrom(resource, context, user, timestamp);
    if (!message) return null;
    return { ...base, type: 'message', user, message };
  }

  if (snippet.type === 'superChatEvent') {
    const details = snippet.superChatDetails;
    return {
      ...base,
      type: 'donation',
      user,
      message: messageFrom(resource, context, user, timestamp, details?.userComment),
      data: { kind: 'super-chat', ...details },
    };
  }

  if (snippet.type === 'superStickerEvent') {
    const details = snippet.superStickerDetails;
    const alt = details?.superStickerMetadata?.altText;
    return {
      ...base,
      type: 'donation',
      user,
      message: messageFrom(resource, context, user, timestamp, alt),
      data: { kind: 'super-sticker', ...details },
    };
  }

  if (snippet.type === 'newSponsorEvent' || snippet.type === 'memberMilestoneChatEvent') {
    const milestone = snippet.memberMilestoneChatDetails;
    return {
      ...base,
      type: 'subscription',
      user,
      message: messageFrom(resource, context, user, timestamp, milestone?.userComment),
      data: {
        kind: snippet.type === 'newSponsorEvent' ? 'new-member' : 'member-milestone',
        ...(snippet.newSponsorDetails ?? {}),
        ...(milestone ?? {}),
      },
    };
  }

  if (snippet.type === 'membershipGiftingEvent') {
    return {
      ...base,
      type: 'gift-subscription',
      user,
      data: { kind: 'membership-gifting', ...snippet.membershipGiftingDetails },
    };
  }

  if (snippet.type === 'giftMembershipReceivedEvent') {
    return {
      ...base,
      type: 'gift-subscription',
      user,
      data: { kind: 'gift-membership-received', ...snippet.giftMembershipReceivedDetails },
    };
  }

  if (snippet.type === 'messageDeletedEvent' || snippet.type === 'tombstone') {
    return {
      ...base,
      type: 'message-delete',
      data: {
        messageId: snippet.messageDeletedDetails?.deletedMessageId ?? resource.id,
        kind: snippet.type === 'tombstone' ? 'tombstone' : 'message-deleted',
      },
    };
  }

  if (snippet.type === 'userBannedEvent') {
    const banned = snippet.userBannedDetails;
    const bannedUser = userFromAuthor(banned?.bannedUserDetails);
    const temporary = banned?.banType?.toLowerCase().includes('temporary') ?? false;
    return {
      ...base,
      type: temporary ? 'user-timeout' : 'user-ban',
      user: bannedUser,
      data: {
        banType: banned?.banType,
        durationSeconds: banned?.banDurationSeconds,
      },
    };
  }

  if (snippet.type === 'pollEvent') {
    const details=snippet.pollDetails;
    const metadata=details&&typeof details==='object'&&'metadata' in details?details.metadata:undefined;
    if(metadata&&typeof metadata==='object'&&'status' in metadata&&'questionText' in metadata&&'options' in metadata){
      const {status,questionText,options}=metadata;
      if((status==='active'||status==='closed')&&typeof questionText==='string'&&questionText.trim()&&resource.id.length<=128&&Array.isArray(options)&&options.length>=2&&options.length<=4){
        const choices=options.map((row:unknown,i:number)=>{
          if(!row||typeof row!=='object'||!('optionText' in row)||typeof row.optionText!=='string'||!row.optionText.trim())return null;
          const tally='tally' in row?row.tally:undefined;
          const votes=typeof tally==='string'&&/^\d{1,16}$/.test(tally)?Number(tally):NaN;
          return {id:String(i),title:row.optionText.trim().slice(0,100),...(Number.isSafeInteger(votes)&&votes>=0?{votes}:{})};
        });
        if(choices.every(c=>c!==null))return {...base,type:'poll',timestamp:now,user,data:{id:resource.id,phase:status==='active'?'progress':'end',status,title:questionText.trim().slice(0,160),choices}};
      }
    }
    return { ...base, type: 'system', user, data: { kind: 'poll', poll: snippet.pollDetails } };
  }

  if (snippet.type === 'giftEvent') {
    const metadata = snippet.giftEventDetails?.giftMetadata;
    return {
      ...base,
      type: 'donation',
      user,
      message: messageFrom(resource, context, user, timestamp, metadata?.altText),
      data: { kind: 'gift', ...metadata },
    };
  }

  if (snippet.type === 'sponsorOnlyModeStartedEvent' || snippet.type === 'sponsorOnlyModeEndedEvent') {
    return {
      ...base,
      type: 'room-state',
      data: { membersOnly: snippet.type === 'sponsorOnlyModeStartedEvent' },
    };
  }

  if (snippet.type === 'chatEndedEvent') {
    return { ...base, type: 'system', data: { kind: 'chat-ended' } };
  }

  return {
    ...base,
    type: 'system',
    user,
    message: messageFrom(resource, context, user, timestamp),
    data: { kind: 'youtube-live-chat-event', eventType: snippet.type, snippet },
  };
}
