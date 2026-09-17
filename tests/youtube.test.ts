import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectYouTubeChat,
  normalizeYouTubeLiveChatMessage,
  resolveYouTubeLiveChat,
} from '../src/index';

describe('YouTube live chat normalization', () => {
  it('normalizes text messages with YouTube identity roles', () => {
    const event = normalizeYouTubeLiveChatMessage({
      id: 'message-1',
      snippet: {
        type: 'textMessageEvent',
        publishedAt: '2026-09-17T20:00:00Z',
        displayMessage: 'hello world',
      },
      authorDetails: {
        channelId: 'viewer-1',
        displayName: 'Viewer',
        isChatModerator: true,
        isChatSponsor: true,
      },
    }, { channelId: 'channel-1', channelName: 'Streamer' });

    expect(event).toMatchObject({
      id: 'message-1',
      type: 'message',
      platform: 'youtube',
      channelId: 'channel-1',
      user: {
        id: 'viewer-1',
        username: 'Viewer',
        roles: ['moderator', 'member'],
        badgeRefs: [
          { id: 'moderator', provider: 'youtube' },
          { id: 'member', provider: 'youtube' },
        ],
      },
      message: { text: 'hello world' },
    });
  });

  it('keeps Super Chat money semantics separate from Twitch cheers', () => {
    const event = normalizeYouTubeLiveChatMessage({
      id: 'super-1',
      snippet: {
        type: 'superChatEvent',
        publishedAt: '2026-09-17T20:00:00Z',
        superChatDetails: {
          amountMicros: '5000000',
          currency: 'USD',
          amountDisplayString: '$5.00',
          userComment: 'nice!',
          tier: 2,
        },
      },
      authorDetails: { channelId: 'viewer-1', displayName: 'Viewer' },
    });

    expect(event).toMatchObject({
      type: 'donation',
      user: { id: 'viewer-1' },
      message: { text: 'nice!' },
      data: {
        kind: 'super-chat',
        amountMicros: '5000000',
        currency: 'USD',
        amountDisplayString: '$5.00',
      },
    });
  });

  it('normalizes memberships, gifts, deletes, and bans', () => {
    expect(normalizeYouTubeLiveChatMessage({
      id: 'member-1',
      snippet: {
        type: 'memberMilestoneChatEvent',
        memberMilestoneChatDetails: { memberMonth: 12, memberLevelName: 'Gold', userComment: 'one year!' },
      },
      authorDetails: { channelId: 'viewer-1', displayName: 'Viewer', isChatSponsor: true },
    })).toMatchObject({
      type: 'subscription',
      data: { kind: 'member-milestone', memberMonth: 12, memberLevelName: 'Gold' },
    });

    expect(normalizeYouTubeLiveChatMessage({
      id: 'gift-1',
      snippet: {
        type: 'membershipGiftingEvent',
        membershipGiftingDetails: { giftMembershipsCount: 5, giftMembershipsLevelName: 'Gold' },
      },
      authorDetails: { channelId: 'gifter-1', displayName: 'Gifter' },
    })).toMatchObject({
      type: 'gift-subscription',
      data: { kind: 'membership-gifting', giftMembershipsCount: 5 },
    });

    expect(normalizeYouTubeLiveChatMessage({
      id: 'delete-event',
      snippet: { type: 'messageDeletedEvent', messageDeletedDetails: { deletedMessageId: 'message-9' } },
    })).toMatchObject({ type: 'message-delete', data: { messageId: 'message-9' } });

    expect(normalizeYouTubeLiveChatMessage({
      id: 'ban-event',
      snippet: {
        type: 'userBannedEvent',
        userBannedDetails: {
          banType: 'temporary',
          banDurationSeconds: '300',
          bannedUserDetails: { channelId: 'bad-1', displayName: 'Bad Viewer' },
        },
      },
    })).toMatchObject({
      type: 'user-timeout',
      user: { id: 'bad-1', username: 'Bad Viewer' },
      data: { durationSeconds: '300' },
    });

    expect(normalizeYouTubeLiveChatMessage({
      id: 'deleted-message-id',
      snippet: { type: 'tombstone' },
    })).toMatchObject({
      type: 'message-delete',
      data: { messageId: 'deleted-message-id', kind: 'tombstone' },
    });
  });

  it('normalizes Jewels gifts as donation events without flattening their metadata', () => {
    expect(normalizeYouTubeLiveChatMessage({
      id: 'gift-event-1',
      snippet: {
        type: 'giftEvent',
        giftEventDetails: {
          giftMetadata: {
            jewelsAmount: 25,
            giftName: 'Rose',
            giftUrl: 'https://example.test/rose.png',
            comboCount: 3,
            altText: 'Rose gift',
          },
        },
      },
      authorDetails: { channelId: 'viewer-1', displayName: 'Viewer' },
    })).toMatchObject({
      type: 'donation',
      user: { id: 'viewer-1' },
      message: { text: 'Rose gift' },
      data: { kind: 'gift', jewelsAmount: 25, giftName: 'Rose', comboCount: 3 },
    });
  });
});

describe('YouTube live chat transport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('resolves a video to its active chat and follows YouTube polling cadence', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/videos?')) {
        return new Response(JSON.stringify({
          items: [{
            snippet: { channelId: 'channel-1', channelTitle: 'Streamer' },
            liveStreamingDetails: { activeLiveChatId: 'live-chat-1' },
          }],
        }), { status: 200 });
      }
      if (url.includes('/liveChat/messages?')) {
        return new Response(JSON.stringify({
          nextPageToken: 'next-1',
          pollingIntervalMillis: 1000,
          offlineAt: '2026-09-17T20:01:00Z',
          items: [{
            id: 'message-1',
            snippet: { type: 'textMessageEvent', publishedAt: '2026-09-17T20:00:00Z', displayMessage: 'hello' },
            authorDetails: { channelId: 'viewer-1', displayName: 'Viewer' },
          }],
        }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveYouTubeLiveChat('video-1', { apiKey: 'key-1' })).resolves.toEqual({
      videoId: 'video-1',
      liveChatId: 'live-chat-1',
      channelId: 'channel-1',
      channelName: 'Streamer',
    });

    const events: Array<{ type: string }> = [];
    const states: string[] = [];
    const connection = await connectYouTubeChat({
      videoId: 'video-1',
      apiKey: 'key-1',
      onEvent: (event) => events.push(event),
      onStateChange: (state) => states.push(state),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(connection.liveChat).toMatchObject({ liveChatId: 'live-chat-1', channelId: 'channel-1' });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'message' }),
      expect.objectContaining({ type: 'stream-offline' }),
    ]));
    expect(states).toEqual(expect.arrayContaining(['connecting', 'connected', 'disconnected']));
    expect(calls.some((url) => url.includes('key=key-1'))).toBe(true);
    connection.close();
  });

  it('emits mutable gift combo updates and active poll state without losing same-id changes', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      const comboCount = call === 1 ? 1 : 2;
      return new Response(JSON.stringify({
        nextPageToken: `page-${call + 1}`,
        pollingIntervalMillis: 100,
        ...(call > 1 ? { offlineAt: '2026-09-17T20:03:00Z' } : {}),
        items: [{
          id: 'gift-same-id',
          snippet: {
            type: 'giftEvent',
            giftEventDetails: { giftMetadata: { giftName: 'Rose', comboCount } },
          },
          authorDetails: { channelId: 'gifter', displayName: 'Gifter' },
        }],
        activePollItem: {
          id: 'poll-1',
          snippet: { type: 'pollEvent', pollDetails: { status: call === 1 ? 'active' : 'closed' } },
        },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const events: Array<{ type: string; id?: string; data?: unknown }> = [];
    const connection = await connectYouTubeChat({
      liveChatId: 'live-chat-1',
      apiKey: 'key-1',
      onEvent: (event) => events.push(event),
    });
    await new Promise((resolve) => setTimeout(resolve, 160));

    const gifts = events.filter((event) => event.id === 'gift-same-id');
    expect(gifts).toHaveLength(2);
    expect(gifts.map((event) => (event.data as { comboCount?: number }).comboCount)).toEqual([1, 2]);
    const polls = events.filter((event) => event.id === 'poll-1');
    expect(polls).toHaveLength(2);
    connection.close();
  });

  it('stops instead of retrying forever when YouTube reports that live chat ended', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: {
        message: 'The live chat is no longer live.',
        errors: [{ reason: 'liveChatEnded' }],
      },
    }), { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    const states: string[] = [];
    const events: Array<{ type: string; data?: unknown }> = [];
    const errors: Error[] = [];
    const connection = await connectYouTubeChat({
      liveChatId: 'ended-chat',
      apiKey: 'key-1',
      onEvent: (event) => events.push(event),
      onStateChange: (state) => states.push(state),
      onError: (error) => errors.push(error),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['connecting', 'disconnected']);
    expect(errors[0]?.message).toContain('no longer live');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'system',
      data: expect.objectContaining({ kind: 'chat-ended', reason: 'liveChatEnded' }),
    }));
    connection.close();
  });

  it('can skip initial history while retaining the continuation token', async () => {
    let call = 0;
    const seenUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seenUrls.push(url);
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({
          nextPageToken: 'page-2',
          pollingIntervalMillis: 100,
          items: [{
            id: 'old-message',
            snippet: { type: 'textMessageEvent', displayMessage: 'old' },
            authorDetails: { channelId: 'old', displayName: 'Old' },
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        nextPageToken: 'page-3',
        offlineAt: '2026-09-17T20:02:00Z',
        items: [{
          id: 'new-message',
          snippet: { type: 'textMessageEvent', displayMessage: 'new' },
          authorDetails: { channelId: 'new', displayName: 'New' },
        }],
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const events: Array<{ type: string; id?: string }> = [];
    const connection = await connectYouTubeChat({
      liveChatId: 'live-chat-1',
      apiKey: 'key-1',
      emitInitialHistory: false,
      onEvent: (event) => events.push(event),
    });
    await new Promise((resolve) => setTimeout(resolve, 160));

    expect(events.find((event) => event.id === 'old-message')).toBeUndefined();
    expect(events.find((event) => event.id === 'new-message')).toMatchObject({ type: 'message' });
    expect(seenUrls[1]).toContain('pageToken=page-2');
    connection.close();
  });
});
