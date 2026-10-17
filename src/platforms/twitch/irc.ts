import type { ChatConnectionState, ChatEvent, ChatMessage, ChatUser } from '../../types/chat';
import type { EmoteSet } from '../../types/emotes';
import { parseMessageFragments, twitchEmoteSpansFromTag } from '../../messages/parse';

const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
const MAX_BUFFER_LENGTH = 128 * 1024;
const READY_TIMEOUT_MS = 15_000;
const MAX_DELAY_MS = 30_000;
const CHANNEL_PATTERN = /^[a-zA-Z0-9_]{1,25}$/u;
const ANON_NICK_PATTERN = /^justinfan\d{5}$/u;

export interface TwitchIrcFrame {
  tags: Record<string, string>;
  prefix?: string;
  command: string;
  params: string[];
  raw: string;
}

const unescapeTag = (value: string): string =>
  value.replace(/\\([:snr\\])/gu, (_, code: string) =>
    code === 's' ? ' ' : code === ':' ? ';' : code === 'n' ? '\n' : code === 'r' ? '\r' : '\\');

export function parseTwitchIrcLine(input: string): TwitchIrcFrame | null {
  const raw = input.replace(/\r?\n$/u, '');
  if (!raw || raw.length > MAX_BUFFER_LENGTH) return null;
  let rest = raw;
  const tags: Record<string, string> = {};
  if (rest.startsWith('@')) {
    const end = rest.indexOf(' ');
    if (end <= 1) return null;
    for (const token of rest.slice(1, end).split(';')) {
      if (!token) continue;
      const equals = token.indexOf('=');
      const key = equals < 0 ? token : token.slice(0, equals);
      if (!/^[a-zA-Z0-9/_.-]+$/u.test(key)) continue;
      tags[key] = equals < 0 ? '' : unescapeTag(token.slice(equals + 1));
    }
    rest = rest.slice(end).trimStart();
  }
  let prefix: string | undefined;
  if (rest.startsWith(':')) {
    const end = rest.indexOf(' ');
    if (end <= 1) return null;
    prefix = rest.slice(1, end);
    rest = rest.slice(end).trimStart();
  }
  const split = rest.search(/ /u);
  const command = split < 0 ? rest : rest.slice(0, split);
  if (!/^(?:[a-zA-Z]+|\d{3})$/u.test(command)) return null;
  rest = split < 0 ? '' : rest.slice(split + 1);
  const params: string[] = [];
  while (rest) {
    rest = rest.trimStart();
    if (!rest) break;
    if (rest.startsWith(':')) {
      params.push(rest.slice(1));
      break;
    }
    const space = rest.indexOf(' ');
    if (space < 0) {
      params.push(rest);
      break;
    }
    params.push(rest.slice(0, space));
    rest = rest.slice(space + 1);
  }
  return { tags, prefix, command, params, raw };
}

export interface TwitchIrcNormalizeContext {
  channel: string;
  emotes?: EmoteSet;
  fallbackId?: string;
  now?: () => number;
}

const optionalTag = (tags: Record<string, string>, key: string): string | undefined =>
  tags[key] || undefined;
const maybeInt = (value?: string): number | undefined => {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};
const parseBadges = (value?: string) => (value ?? '').split(',').flatMap((pair) => {
  const slash = pair.indexOf('/');
  if (slash <= 0 || slash === pair.length - 1) return [];
  return [{ provider: 'twitch' as const, id: pair.slice(0, slash), version: pair.slice(slash + 1) }];
});
const sourceFromTags = (tags: Record<string, string>): ChatMessage['source'] => {
  const channelId = optionalTag(tags, 'source-room-id');
  const messageId = optionalTag(tags, 'source-id');
  const badgeRefs = parseBadges(tags['source-badges']);
  const sourceOnly = tags['source-only'] === '1' ? true : tags['source-only'] === '0' ? false : undefined;
  if (!channelId && !messageId && badgeRefs.length === 0 && sourceOnly === undefined) return undefined;
  return { ...(channelId ? { channelId } : {}), ...(messageId ? { messageId } : {}),
    ...(badgeRefs.length ? { badgeRefs } : {}), ...(sourceOnly === undefined ? {} : { sourceOnly }) };
};

export function normalizeTwitchIrcFrame(
  frame: TwitchIrcFrame,
  context: TwitchIrcNormalizeContext,
): ChatEvent | null {
  const { command, params, tags } = frame;
  const channel = context.channel.replace(/^#/u, '').toLowerCase();
  if (!CHANNEL_PATTERN.test(channel)) return null;
  if (!['PRIVMSG', 'USERNOTICE', 'CLEARMSG', 'CLEARCHAT', 'ROOMSTATE'].includes(command)) return null;
  if (params[0]?.toLowerCase() !== '#' + channel) return null;

  const timestamp = maybeInt(tags['tmi-sent-ts']) ?? context.now?.() ?? Date.now();
  const channelId = optionalTag(tags, 'room-id');
  const base = { platform: 'twitch' as const, channelId, channelName: channel, timestamp, raw: frame };
  const login = frame.prefix?.split('!')[0]?.toLowerCase();
  // USERNOTICE is commonly sent from tmi.twitch.tv rather than the viewer.
  // Never identify Twitch's IRC server as the person who subscribed or raided.
  const username = optionalTag(tags, 'login')
    ?? (command === 'USERNOTICE' ? optionalTag(tags, 'msg-param-login')
      ?? optionalTag(tags, 'display-name')?.toLowerCase() : undefined)
    ?? (login && login !== 'tmi.twitch.tv' ? login : undefined)
    ?? channel;
  const roles = parseBadges(tags.badges).map((badge) => badge.id);
  if (tags.mod === '1' && !roles.includes('moderator')) roles.push('moderator');
  if (tags.subscriber === '1' && !roles.includes('subscriber')) roles.push('subscriber');
  const user: ChatUser = {
    platform: 'twitch',
    ...(optionalTag(tags, 'user-id') ? { id: tags['user-id'] } : {}),
    username,
    displayName: optionalTag(tags, 'display-name') ?? username,
    ...(optionalTag(tags, 'color') ? { color: tags.color } : {}),
    ...(roles.length ? { roles } : {}),
    ...(tags.badges ? { badgeRefs: parseBadges(tags.badges) } : {}),
  };

  if (command === 'CLEARMSG') {
    const messageId = optionalTag(tags, 'target-msg-id');
    return messageId ? { ...base, type: 'message-delete', data: { messageId }, user } : null;
  }
  if (command === 'CLEARCHAT') {
    const target = params[1];
    if (!target) return { ...base, type: 'system', data: { kind: 'chat-clear' } };
    const durationSeconds = maybeInt(tags['ban-duration']);
    const targetUser: ChatUser = { platform: 'twitch', username: target,
      ...(optionalTag(tags, 'target-user-id') ? { id: tags['target-user-id'] } : {}) };
    return {
      ...base, type: durationSeconds !== undefined ? 'user-timeout' : 'user-ban', user: targetUser,
      data: { kind: 'chat-clear-user', ...(durationSeconds === undefined ? {} : { durationSeconds }) },
    };
  }
  if (command === 'ROOMSTATE') {
    const slow = maybeInt(tags.slow);
    return { ...base, type: 'room-state', data: { kind: 'chat-settings',
      ...(slow === undefined ? {} : { slow }),
      ...(tags['emote-only'] !== undefined ? { emoteOnly: tags['emote-only'] === '1' } : {}),
      ...(tags['subs-only'] !== undefined ? { subsOnly: tags['subs-only'] === '1' } : {}),
      ...(tags['followers-only'] !== undefined ? { followersOnly: tags['followers-only'] } : {}),
    } };
  }

  const text = params[1] ?? '';
  const id = optionalTag(tags, 'id') ?? context.fallbackId;
  if (!id) return null;
  const nativeEmotes: Record<string, string[]> = {};
  for (const item of (tags.emotes ?? '').split('/')) {
    const colon = item.indexOf(':');
    if (colon > 0) nativeEmotes[item.slice(0, colon)] = item.slice(colon + 1).split(',');
  }
  const fragments = parseMessageFragments(text, {
    emotes: context.emotes,
    nativeEmotes: twitchEmoteSpansFromTag(nativeEmotes),
  });
  const replyToMessageId = optionalTag(tags, 'reply-parent-msg-id');
  const source = sourceFromTags(tags);
  const message: ChatMessage = {
    id, platform: 'twitch', channelId, channelName: channel,
    user, text, fragments, timestamp,
    ...(replyToMessageId ? { replyToMessageId,
      reply: { parentMessageId: replyToMessageId,
        parentUsername: optionalTag(tags, 'reply-parent-user-login'),
        parentDisplayName: optionalTag(tags, 'reply-parent-display-name'),
        parentMessageBody: optionalTag(tags, 'reply-parent-msg-body') } } : {}),
    ...(source ? { source } : {}),
    traits: {
      ...(tags['first-msg'] === '1' ? { firstMessage: true } : {}),
      ...(tags['msg-id'] === 'highlighted-message' ? { highlighted: true } : {}),
      ...(optionalTag(tags, 'custom-reward-id') ? { customRewardId: tags['custom-reward-id'] } : {}),
    },
    raw: frame,
  };

  if (command === 'USERNOTICE') {
    const noticeType = optionalTag(tags, 'msg-id') ?? 'unknown';
    const type = ['sub', 'resub', 'anonsub'].includes(noticeType) ? 'subscription'
      : ['subgift', 'anonsubgift', 'submysterygift'].includes(noticeType) ? 'gift-subscription'
        : noticeType === 'raid' ? 'raid'
          : ['viewermilestone', 'announcement'].includes(noticeType) && text ? 'message' : 'system';
    const viewers = maybeInt(tags['msg-param-viewerCount']);
    return { ...base, id, type, user, message,
      data: { kind: 'chat-notification', noticeType, systemMessage: optionalTag(tags, 'system-msg'),
        ...(noticeType === 'raid' && viewers !== undefined ? { viewers } : {}) } };
  }
  const bits = maybeInt(tags.bits);
  return { ...base, id, type: bits && bits > 0 ? 'cheer' : 'message', user, message,
    ...(bits && bits > 0 ? { data: { bits } } : {}) };
}

export interface TwitchIrcConnectOptions {
  channel: string;
  /** Optional testable anonymous nickname. Must be justinfan followed by five digits. */
  nickname?: string;
  emotes?: EmoteSet;
  getEmotes?: () => EmoteSet;
  signal?: AbortSignal;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  onEvent: (event: ChatEvent) => void;
  onStateChange?: (state: ChatConnectionState) => void;
  onError?: (error: Error) => void;
}

export interface TwitchIrcConnection {
  channel: string;
  close(): void;
}

export function connectTwitchIrcChat(options: TwitchIrcConnectOptions): TwitchIrcConnection {
  const channel = options.channel.trim().replace(/^#/u, '').toLowerCase();
  if (!CHANNEL_PATTERN.test(channel)) throw new Error('Invalid Twitch IRC channel');
  const nickname = options.nickname ?? 'justinfan' + String(Math.floor(10000 + Math.random() * 90000));
  if (!ANON_NICK_PATTERN.test(nickname)) throw new Error('Invalid anonymous Twitch IRC nickname');
  if (options.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
  const baseMs = options.reconnectBaseDelayMs ?? 1000;
  const maxMs = options.reconnectMaxDelayMs ?? MAX_DELAY_MS;
  if (!Number.isFinite(baseMs) || baseMs < 100 || !Number.isFinite(maxMs) || maxMs < baseMs) {
    throw new RangeError('Invalid Twitch IRC reconnect delay');
  }

  let socket: WebSocket | null = null;
  let stopped = false;
  let retries = 0;
  let sequence = 0;
  let buffer = '';
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = () => {
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    if (readyTimer !== undefined) clearTimeout(readyTimer);
    reconnectTimer = undefined;
    readyTimer = undefined;
  };
  const emitError = (message: string) => options.onError?.(new Error(message));

  const schedule = () => {
    if (stopped || reconnectTimer !== undefined) return;
    options.onStateChange?.('reconnecting');
    const delay = Math.min(maxMs, baseMs * 2 ** Math.min(retries++, 12));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      open();
    }, delay);
  };

  const acknowledge = () => {
    if (readyTimer !== undefined) clearTimeout(readyTimer);
    readyTimer = undefined;
    retries = 0;
    options.onStateChange?.('connected');
  };

  const handleLine = (current: WebSocket, line: string) => {
    const frame = parseTwitchIrcLine(line);
    if (!frame) return;
    if (frame.command === 'PING') {
      current.send('PONG :' + (frame.params.at(-1) ?? 'tmi.twitch.tv') + '\r\n');
      return;
    }
    if (frame.command === 'RECONNECT') {
      current.close();
      return;
    }
    if ((frame.command === 'ROOMSTATE' && frame.params[0]?.toLowerCase() === '#' + channel) ||
        (frame.command === '366' && frame.params.some((p) => p.toLowerCase() === '#' + channel))) {
      if (readyTimer !== undefined) acknowledge();
    }
    const event = normalizeTwitchIrcFrame(frame, {
      channel, emotes: options.getEmotes?.() ?? options.emotes,
      fallbackId: 'irc:' + channel + ':' + String(sequence++),
    });
    if (event) options.onEvent({ ...event, origin: 'live' });
  };

  function open() {
    if (stopped) return;
    options.onStateChange?.(retries > 0 ? 'reconnecting' : 'connecting');
    buffer = '';
    let next: WebSocket;
    try {
      next = new WebSocket(IRC_URL);
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error('Twitch IRC socket setup failed'));
      schedule();
      return;
    }
    socket = next;
    next.onopen = () => {
      if (stopped || socket !== next) return;
      next.send('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership\r\n');
      next.send('PASS SCHMOOPIIE\r\n');
      next.send('NICK ' + nickname + '\r\n');
      next.send('JOIN #' + channel + '\r\n');
      readyTimer = setTimeout(() => {
        if (stopped || socket !== next) return;
        emitError('Twitch IRC join acknowledgment timed out');
        next.close();
      }, READY_TIMEOUT_MS);
    };
    next.onmessage = (event) => {
      if (stopped || socket !== next || typeof event.data !== 'string') return;
      buffer += event.data;
      if (buffer.length > MAX_BUFFER_LENGTH) {
        buffer = '';
        emitError('Twitch IRC frame exceeded size limit');
        next.close();
        return;
      }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/u, '');
        buffer = buffer.slice(end + 1);
        if (line) handleLine(next, line);
        if (stopped || socket !== next) return;
      }
    };
    next.onerror = () => {
      if (stopped || socket !== next) return;
      emitError('Twitch IRC WebSocket error');
      next.close();
    };
    next.onclose = () => {
      if (stopped || socket !== next) return;
      socket = null;
      if (readyTimer !== undefined) clearTimeout(readyTimer);
      readyTimer = undefined;
      schedule();
    };
  }

  const close = () => {
    if (stopped) return;
    stopped = true;
    clearTimers();
    options.signal?.removeEventListener('abort', close);
    const previous = socket;
    socket = null;
    if (previous) {
      previous.onopen = null;
      previous.onmessage = null;
      previous.onerror = null;
      previous.onclose = null;
      previous.close();
    }
    options.onStateChange?.('disconnected');
  };
  options.signal?.addEventListener('abort', close, { once: true });
  open();
  return { channel, close };
}
