import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeYouTubeInnertubeChatItem } from '../src/platforms/youtube/innertube-normalize';
import { connectYouTubeInnertubeChat } from '../src/platforms/youtube/innertube';

const mocked = vi.hoisted(() => ({ instances: [] as Array<EventEmitter & { stop: ReturnType<typeof vi.fn>; args: unknown[] }>, shouldStart: true }));
vi.mock('youtube-chat-next', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    LiveChat: class extends EventEmitter {
      args: unknown[];
      stop = vi.fn(() => this.emit('end', 'stopped'));
      constructor(...args: unknown[]) {
        super();
        this.args = args;
        mocked.instances.push(this as unknown as (typeof mocked.instances)[number]);
      }
      async start() {
        if (!mocked.shouldStart) {
          this.emit('error', new Error('not live'));
          return false;
        }
        this.emit('start', 'live-video-1');
        return true;
      }
    },
  };
});

const item = {
  id: 'chat-1',
  author: {
    name: 'Viewer',
    channelId: 'viewer-123',
    thumbnail: { url: 'https://yt.test/avatar', alt: 'Viewer' },
  },
  message: [
    { text: 'hello ' },
    { url: 'https://yt.test/wave.webp', alt: ':wave:', emojiText: ':wave:', isCustomEmoji: true },
    { text: '!' },
  ],
  isMembership: true,
  isVerified: false,
  isOwner: false,
  isModerator: true,
  timestamp: new Date('2026-11-22T00:00:00Z'),
};

beforeEach(() => {
  mocked.instances.length = 0;
  mocked.shouldStart = true;
});

describe('credential-free YouTube event conversion', () => {
  it('preserves ordered text and image emote runs with stable YouTube identity', () => {
    const event = normalizeYouTubeInnertubeChatItem(item, { channelId: 'owner-channel' });
    expect(event).toMatchObject({
      type: 'message', platform: 'youtube', id: 'chat-1',
      channelId: 'owner-channel', timestamp: item.timestamp.getTime(),
      user: { id: 'viewer-123', username: 'Viewer', roles: ['moderator', 'member'] },
      message: { text: 'hello :wave:!', fragments: [
        { type: 'text', text: 'hello ' },
        { type: 'emote', text: ':wave:', emote: { provider: 'youtube', url: 'https://yt.test/wave.webp' } },
        { type: 'text', text: '!' },
      ] },
    });
    expect(event?.origin).toBeUndefined();
  });

  it('keeps paid stickers without message text as donation events', () => {
    const event = normalizeYouTubeInnertubeChatItem({
      ...item, id: 'paid-1', message: [], isMembership: false, isModerator: false,
      superchat: { amount: '$5.00', color: '#FF0000', sticker: { url: '//yt.test/sticker.webp', alt: 'Sticker' } },
    });
    expect(event).toMatchObject({
      type: 'donation', id: 'paid-1',
      data: { kind: 'super-sticker', formattedAmount: '$5.00', sticker: { url: 'https://yt.test/sticker.webp' } },
    });
  });

  it('keeps Unicode emoji without an image URL as readable text', () => {
    const event = normalizeYouTubeInnertubeChatItem({ ...item, message: [
      { url: '', alt: ':clap:', emojiText: '👏', isCustomEmoji: false },
    ] });
    expect(event?.message?.fragments).toEqual([{ type: 'text', text: '👏' }]);
  });
});

describe('credential-free YouTube transport', () => {
  it('requests unfiltered live chat, deduplicates messages, and closes cleanly', async () => {
    const events: unknown[] = [];
    const states: string[] = [];
    const connection = await connectYouTubeInnertubeChat({
      handle: '@Streamer',
      onEvent: event => events.push(event),
      onStateChange: state => states.push(state),
    });
    const instance = mocked.instances[0]!;
    expect(instance.args).toEqual([{ handle: '@Streamer' }, 1_000, 'live']);
    instance.emit('chat', item);
    instance.emit('chat', item);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 'chat-1', origin: 'live', type: 'message' });
    expect(states).toEqual(['connecting', 'connected']);
    connection.close();
    expect(instance.stop).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe('disconnected');
    instance.emit('chat', item);
    expect(events).toHaveLength(1);
  });

  it('honors cancellation and does not keep emitting after abort', async () => {
    const controller = new AbortController();
    const states: string[] = [];
    const connection = await connectYouTubeInnertubeChat({
      liveId: 'live-1', signal: controller.signal, onEvent: () => {},
      onStateChange: state => states.push(state),
    });
    controller.abort();
    expect(mocked.instances[0]?.stop).toHaveBeenCalledOnce();
    expect(states.at(-1)).toBe('disconnected');
    connection.close();
    expect(mocked.instances[0]?.stop).toHaveBeenCalledOnce();
  });

  it('reports startup failures rather than returning a fake connection', async () => {
    mocked.shouldStart = false;
    const errors: string[] = [];
    await expect(connectYouTubeInnertubeChat({
      channelId: 'channel-1', onEvent: () => {},
      onError: error => errors.push(error.message),
    })).rejects.toThrow('Unable to start');
    expect(errors).toEqual(['not live']);
  });
});
