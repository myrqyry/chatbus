import {describe, expect, it, vi} from 'vitest';
import {createChatBus} from '../src/index';
import type {ChatEvent} from '../src/types/chat';

describe('managed unofficial YouTube reader', () => {
  it('uses the injected Node reader, shares events, and tracks lifecycle without importing Node code into the default bus', async () => {
    const events: ChatEvent[] = [];
    const close = vi.fn();
    let deliver!: (event: ChatEvent) => void;
    let change!: (state: 'connected') => void;
    const connectYouTubeInnertube = vi.fn(async (options: {
      handle?: string; onEvent: (event: ChatEvent) => void;
      onStateChange?: (state: 'connected') => void;
    }) => {
      deliver = options.onEvent;
      change = options.onStateChange!;
      return {close, liveId: 'stream-1'};
    });
    const states: string[] = [];
    const bus = createChatBus({
      onEvent: event => events.push(event),
      onConnectionStateChange: state => states.push(state.id + ':' + state.state),
      connectYouTubeInnertube,
    });
    const handle = await bus.connect({
      platform: 'youtube', transport: 'innertube', options: {handle: '@SomeStreamer'},
    });
    expect(handle).toMatchObject({id:'youtube:@somestreamer',target:'@SomeStreamer'});
    expect(connectYouTubeInnertube).toHaveBeenCalledWith(expect.objectContaining({handle:'@SomeStreamer'}));
    change('connected');
    deliver({platform:'youtube',type:'message',timestamp:123,origin:'live'});
    expect(events).toMatchObject([{platform:'youtube',origin:'live'}]);
    expect(states).toContain('youtube:@somestreamer:connected');
    handle.close();
    expect(close).toHaveBeenCalledOnce();
    expect(bus.states().at(-1)?.state).toBe('disconnected');
  });

  it('fails clearly if the Node reader is not supplied rather than silently using the official API', async () => {
    const bus = createChatBus({onEvent: () => {}});
    await expect(bus.connect({
      platform:'youtube',transport:'innertube',options:{liveId:'live-1'},
    })).rejects.toThrow(/Node|InnerTube/);
    expect(bus.states()).toMatchObject([{
      id:'youtube:live-1',platform:'youtube',state:'error',
    }]);
    bus.close();
  });
});
