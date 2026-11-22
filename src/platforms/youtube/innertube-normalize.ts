import type { ChatEvent, ChatFragment, ChatMessage, ChatUser } from '../../types/chat';
import type { Emote } from '../../types/emotes';
import { parseMessageFragments } from '../../messages/parse';

interface YouTubeInnertubeImage { url: string; alt: string }
interface YouTubeInnertubeEmoji extends YouTubeInnertubeImage {
  emojiText: string;
  isCustomEmoji: boolean;
}
export interface YouTubeInnertubeChatItem {
  id: string;
  author: {
    name: string;
    channelId: string;
    thumbnail?: YouTubeInnertubeImage;
    badge?: { thumbnail: YouTubeInnertubeImage; label: string };
  };
  message: Array<{ text: string } | YouTubeInnertubeEmoji>;
  superchat?: { amount: string; color: string; sticker?: YouTubeInnertubeImage };
  isMembership: boolean;
  isVerified: boolean;
  isOwner: boolean;
  isModerator: boolean;
  timestamp: Date;
}
export interface YouTubeInnertubeNormalizeContext {
  channelId?: string;
  channelName?: string;
}

const imageUrl = (value: string): string | undefined => {
  const url = value.startsWith('//') ? `https:${value}` : value;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
};

function runsToFragments(runs: YouTubeInnertubeChatItem['message']): { text: string; fragments: ChatFragment[] } {
  const fragments: ChatFragment[] = [];
  let text = '';
  const appendText = (part: string) => {
    if (!part) return;
    text += part;
    const parsed = parseMessageFragments(part);
    const preceding = fragments.at(-1);
    if (preceding?.type === 'text' && parsed[0]?.type === 'text') {
      preceding.text += parsed.shift()!.text;
    }
    fragments.push(...parsed);
  };
  for (const run of runs) {
    if ('text' in run) {
      appendText(run.text);
      continue;
    }
    const code = run.emojiText || run.alt;
    const url = imageUrl(run.url);
    if (!url) {
      appendText(code);
      continue;
    }
    text += code;
    const emote: Emote = {
      id: run.alt || run.emojiText || url,
      code,
      url,
      zeroWidth: false,
      provider: run.isCustomEmoji ? 'youtube' : 'emoji',
      raw: run,
    };
    fragments.push({ type: 'emote', text: code, emote, overlays: [], modifiers: [] });
  }
  return { text, fragments };
}

/** Pure conversion of the unofficial reader's limited message/emoji/paid-message contract.
 * Caller owns the live provenance and transport lifecycle.
 */
export function normalizeYouTubeInnertubeChatItem(
  item: YouTubeInnertubeChatItem,
  context: YouTubeInnertubeNormalizeContext = {},
): ChatEvent | null {
  if (!item.id || !item.author?.name || !item.author.channelId) return null;
  const roles: string[] = [];
  if (item.isOwner) roles.push('owner');
  if (item.isModerator) roles.push('moderator');
  if (item.isMembership) roles.push('member');
  if (item.isVerified) roles.push('verified');
  const user: ChatUser = {
    platform: 'youtube',
    id: item.author.channelId,
    username: item.author.name,
    displayName: item.author.name,
    roles,
    badgeRefs: roles.map(id => ({ id, provider: 'youtube' as const })),
    raw: item.author,
  };
  const timestamp = item.timestamp instanceof Date && Number.isFinite(item.timestamp.getTime())
    ? item.timestamp.getTime() : Date.now();
  const { text, fragments } = runsToFragments(item.message ?? []);
  const message: ChatMessage | undefined = text ? {
    id: item.id,
    platform: 'youtube',
    channelId: context.channelId,
    channelName: context.channelName,
    user,
    text,
    fragments,
    timestamp,
    raw: item,
  } : undefined;
  const superchat = item.superchat;
  const stickerUrl = superchat?.sticker && imageUrl(superchat.sticker.url);
  return {
    id: item.id,
    platform: 'youtube',
    channelId: context.channelId,
    channelName: context.channelName,
    timestamp,
    type: superchat ? 'donation' : 'message',
    user,
    message,
    data: superchat ? {
      kind: superchat.sticker ? 'super-sticker' : 'super-chat',
      formattedAmount: superchat.amount,
      color: superchat.color,
      ...(superchat.sticker ? {
        sticker: {
          url: stickerUrl ?? '',
          alt: superchat.sticker.alt,
        },
      } : {}),
    } : undefined,
    raw: item,
  };
}
