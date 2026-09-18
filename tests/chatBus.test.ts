import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatBus } from '../src/index';

describe('multi-platform Chatbus manager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('owns connection identity/state while platform connectors own transport', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      nextPageToken: 'done',
      offlineAt: '2026-09-17T20:00:00Z',
      items: [],
    }), { status: 200 })));

    const states: string[] = [];
    const bus = createChatBus({
      onEvent: () => {},
      onConnectionStateChange: (connection) => states.push(`${connection.id}:${connection.state}`),
    });
    const handle = await bus.connect({
      id: 'yt-main',
      platform: 'youtube',
      options: { liveChatId: 'chat-1', apiKey: 'key-1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handle).toMatchObject({ id: 'yt-main', platform: 'youtube', target: 'chat-1' });
    expect(bus.states().find((entry) => entry.id === 'yt-main')).toBeDefined();
    expect(states.some((entry) => entry === 'yt-main:connecting')).toBe(true);
    expect(bus.disconnect('yt-main')).toBe(true);
    expect(bus.disconnect('yt-main')).toBe(false);
    bus.close();
  });

  it('reserves connection ids while connector setup is still pending', async () => {
    let releaseVideo!: () => void;
    const videoGate = new Promise<void>((resolve) => { releaseVideo = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/videos?')) {
        await videoGate;
        return new Response(JSON.stringify({
          items: [{
            snippet: { channelId: 'channel-1', channelTitle: 'Streamer' },
            liveStreamingDetails: { activeLiveChatId: 'chat-1' },
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        nextPageToken: 'done',
        offlineAt: '2026-09-17T20:00:00Z',
        items: [],
      }), { status: 200 });
    }));

    const bus = createChatBus({ onEvent: () => {} });
    const first = bus.connect({
      id: 'same-pending',
      platform: 'youtube',
      options: { videoId: 'video-1', apiKey: 'key-1' },
    });
    await Promise.resolve();

    await expect(bus.connect({
      id: 'same-pending',
      platform: 'youtube',
      options: { liveChatId: 'chat-2', apiKey: 'key-1' },
    })).rejects.toThrow('already exists');

    releaseVideo();
    const handle = await first;
    handle.close();
  });

  it('releases a reserved id when connector setup fails', async () => {
    let fail = true;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/videos?')) {
        if (fail) return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 });
        return new Response(JSON.stringify({
          items: [{
            snippet: { channelId: 'channel-1', channelTitle: 'Streamer' },
            liveStreamingDetails: { activeLiveChatId: 'chat-1' },
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        nextPageToken: 'done',
        offlineAt: '2026-09-17T20:00:00Z',
        items: [],
      }), { status: 200 });
    }));

    const bus = createChatBus({ onEvent: () => {} });
    await expect(bus.connect({
      id: 'retry-id',
      platform: 'youtube',
      options: { videoId: 'video-1', apiKey: 'key-1' },
    })).rejects.toThrow();

    fail = false;
    const handle = await bus.connect({
      id: 'retry-id',
      platform: 'youtube',
      options: { videoId: 'video-1', apiKey: 'key-1' },
    });
    handle.close();
  });

  it('rejects duplicate connection ids instead of silently replacing a live connection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      nextPageToken: 'next',
      pollingIntervalMillis: 10_000,
      items: [],
    }), { status: 200 })));

    const bus = createChatBus({ onEvent: () => {} });
    const handle = await bus.connect({
      id: 'same',
      platform: 'youtube',
      options: { liveChatId: 'chat-1', apiKey: 'key-1' },
    });
    await expect(bus.connect({
      id: 'same',
      platform: 'youtube',
      options: { liveChatId: 'chat-2', apiKey: 'key-1' },
    })).rejects.toThrow('already exists');
    handle.close();
  });
});
