import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createKickSocket,
  normalizeKickEvent,
  parseKickMessageContent,
  parseKickPusherFrame,
} from '../src/index';

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  closeCount = 0;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCount += 1;
  }

  emitOpen(): void {
    this.onopen?.({} as Event);
  }

  emitMessage(data: string): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }

  emitClose(): void {
    this.onclose?.({} as CloseEvent);
  }
}

describe('Kick protocol', () => {
  it('parses supported Pusher events and ignores control or malformed frames', () => {
    const frame = JSON.stringify({
      event: 'App\\Events\\ChatMessageEvent',
      data: JSON.stringify({
        id: 'message-1',
        chatroom_id: 42,
        content: 'hello',
        created_at: '2026-09-12T18:00:00Z',
        sender: { id: 7, username: 'viewer' },
      }),
    });

    expect(parseKickPusherFrame(frame)).toMatchObject({
      type: 'ChatMessage',
      data: { id: 'message-1', content: 'hello' },
    });
    expect(parseKickPusherFrame(JSON.stringify({ event: 'pusher:ping', data: '{}' }))).toBeNull();
    expect(parseKickPusherFrame(JSON.stringify({
      event: 'App\\Events\\ChatMessageEvent',
      data: JSON.stringify({ id: 'broken' }),
    }))).toBeNull();
    expect(parseKickPusherFrame(JSON.stringify({
      event: 'App\\Events\\ChannelSubscriptionEvent',
      data: JSON.stringify({ id: 99, user: { id: 8, username: 'subscriber' } }),
    }))).toMatchObject({ type: 'ChannelSubscription' });
    expect(parseKickPusherFrame(JSON.stringify({
      event: 'App\\Events\\LuckyUsersWhoGotGiftSubscriptionsEvent',
      data: JSON.stringify({ gifted_usernames: ['lucky'] }),
    }))).toMatchObject({ type: 'LuckyGiftedSubscriptions' });
  });
});

describe('Kick emotes', () => {
  it('turns native markers into display text plus native emote spans', () => {
    const parsed = parseKickMessageContent('yo [emote:37226:KEKW] wow');

    expect(parsed.text).toBe('yo KEKW wow');
    expect(parsed.nativeEmotes).toHaveLength(1);
    expect(parsed.nativeEmotes[0]).toMatchObject({
      id: '37226',
      start: 3,
      end: 6,
      provider: 'kick',
      emote: {
        id: '37226',
        code: 'KEKW',
        provider: 'kick',
        url: 'https://d2egosedh0nm8l.cloudfront.net/emotes/37226/fullsize',
      },
    });
  });
});

describe('Kick normalization', () => {
  it('normalizes messages, native emotes, badges, and replies', () => {
    const event = normalizeKickEvent({
      type: 'ChatMessage',
      data: {
        id: 'message-1',
        chatroom_id: 42,
        content: 'yo [emote:37226:KEKW]',
        created_at: '2026-09-12T18:00:00Z',
        sender: {
          id: 7,
          username: 'viewer',
          identity: {
            color: '#53fc18',
            badges: [{ type: 'subscriber', text: 'Subscriber', count: 3 }],
          },
        },
        metadata: {
          original_message: { id: 'parent-1', content: 'hey' },
        },
      },
    }, { channelName: 'example' });

    expect(event).toMatchObject({
      id: 'message-1',
      type: 'message',
      platform: 'kick',
      channelId: '42',
      channelName: 'example',
      user: {
        id: '7',
        username: 'viewer',
        roles: ['subscriber'],
        badgeRefs: [{ id: 'subscriber', provider: 'kick', version: '3' }],
      },
      message: {
        text: 'yo KEKW',
        replyToMessageId: 'parent-1',
      },
    });
    expect(event?.message?.fragments[1]).toMatchObject({
      type: 'emote',
      text: 'KEKW',
      emote: { id: '37226', provider: 'kick' },
    });
  });

  it('keeps Kick host/poll/pin semantics as system events instead of calling them raids', () => {
    expect(normalizeKickEvent({
      type: 'StreamHost',
      data: { host_username: 'hoster', number_viewers: 12 },
    }, { now: () => 123 })).toMatchObject({
      type: 'system',
      timestamp: 123,
      data: { kind: 'host', host_username: 'hoster', number_viewers: 12 },
    });
  });

  it('normalizes channel-level subscription events used outside the chatroom feed', () => {
    expect(normalizeKickEvent({
      type: 'ChannelSubscription',
      data: { id: 99, user: { id: 8, username: 'subscriber' } },
    })).toMatchObject({
      id: '99',
      type: 'subscription',
      user: { id: '8', username: 'subscriber' },
      data: { kind: 'channel-subscription' },
    });
    expect(normalizeKickEvent({
      type: 'LuckyGiftedSubscriptions',
      data: { id: 'gift-1', gifter_username: 'gifter', gifted_usernames: ['lucky'] },
    })).toMatchObject({
      id: 'gift-1',
      type: 'gift-subscription',
      user: { username: 'gifter' },
      data: { kind: 'lucky-gift-subscriptions', giftedUsernames: ['lucky'] },
    });
  });
});

describe('Kick socket lifecycle', () => {
  const endpoint='wss://realtime.us-east-1.platform.kick.com/connection/websocket';
  let fetcher:ReturnType<typeof vi.fn>;

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    fetcher=vi.fn(async(input:string|URL|Request)=>{
      const url=String(input);
      if(url.endsWith('/api/v1/realtime/auth/connection')){
        return new Response(JSON.stringify({data:{token:'guest-token'}}),{
          status:200,headers:{'content-type':'application/json'},
        });
      }
      if(url.includes('/api/v1/realtime/')){
        return new Response(JSON.stringify({data:{mode:'websocket',connections:[
          {provider:'centrifugo',credentials:{url:endpoint}},
        ]}}),{status:200,headers:{'content-type':'application/json'}});
      }
      throw new Error('unexpected fetch '+url);
    });
    vi.stubGlobal('fetch',fetcher);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('negotiates Centrifugo, authenticates, subscribes all current Kick chat feeds, and only then reports connected', async () => {
    const states:string[]=[];
    const handle=createKickSocket(42,{channelId:'99',onStateChange:s=>states.push(s)});

    await vi.waitFor(()=>expect(MockWebSocket.instances).toHaveLength(1));
    expect(fetcher).toHaveBeenCalledWith(
      'https://web.kick.com/api/v1/realtime/connection',
      expect.objectContaining({method:'POST'}),
    );
    expect(fetcher).toHaveBeenCalledWith(
      'https://web.kick.com/api/v1/realtime/channels/99/chat/connection',
      expect.objectContaining({method:'POST'}),
    );
    expect(fetcher).toHaveBeenCalledWith(
      'https://web.kick.com/api/v1/realtime/auth/connection',
      expect.objectContaining({method:'POST'}),
    );

    const ws=MockWebSocket.instances[0];
    expect(ws.url).toBe(endpoint);
    ws.emitOpen();
    const connect=JSON.parse(ws.sent[0]!);
    expect(connect).toMatchObject({connect:{token:'guest-token',name:'js'}});
    expect(states.at(-1)).toBe('connecting');

    ws.emitMessage(JSON.stringify({id:connect.id,connect:{expires:true,ttl:2700,ping:25}}));
    const subscriptions=ws.sent.slice(1).map(entry=>JSON.parse(entry));
    expect(subscriptions.map(frame=>frame.subscribe?.channel)).toEqual([
      'channel_99','channel.99','chatroom_42','chatrooms.42','chatrooms.42.v2',
    ]);
    expect(states.at(-1)).toBe('connecting');

    for(const frame of subscriptions){
      ws.emitMessage(JSON.stringify({id:frame.id,subscribe:{recoverable:false}}));
    }
    expect(states.at(-1)).toBe('connected');
    handle.close();
  });

  it('unwraps Centrifugo publications into the existing Kick event envelope and answers server pings', async()=>{
    const frames:string[]=[];
    const handle=createKickSocket(42,{channelId:'99',onMessage:value=>frames.push(value)});
    await vi.waitFor(()=>expect(MockWebSocket.instances).toHaveLength(1));
    const ws=MockWebSocket.instances[0];
    ws.emitOpen();
    const connect=JSON.parse(ws.sent[0]!);
    ws.emitMessage(JSON.stringify({id:connect.id,connect:{ping:25}}));
    const subscriptions=ws.sent.slice(1).map(entry=>JSON.parse(entry));
    for(const frame of subscriptions)ws.emitMessage(JSON.stringify({id:frame.id,subscribe:{}}));

    ws.emitMessage('{}');
    expect(ws.sent.at(-1)).toBe('{}');

    const data={
      id:'message-1',chatroom_id:42,content:'hello',
      created_at:'2026-10-27T20:00:00Z',sender:{id:7,username:'viewer'},
    };
    ws.emitMessage(JSON.stringify({push:{channel:'chatrooms.42.v2',pub:{data:{
      event:'App\\Events\\ChatMessageEvent',data:JSON.stringify(data),
    }}}}));
    expect(frames).toHaveLength(1);
    expect(parseKickPusherFrame(frames[0]!)).toMatchObject({
      type:'ChatMessage',data:{id:'message-1',content:'hello'},
    });
    handle.close();
  });

  it('uses a dynamically negotiated Pusher endpoint as fallback instead of a retired hard-coded app key', async()=>{
    fetcher.mockImplementation(async(input:string|URL|Request)=>{
      const url=String(input);
      if(url.includes('/api/v1/realtime/')){
        return new Response(JSON.stringify({data:{mode:'websocket',connections:[
          {provider:'pusher',credentials:{app_key:'freshkey123',cluster:'us2'}},
        ]}}),{status:200,headers:{'content-type':'application/json'}});
      }
      throw new Error('unexpected fetch '+url);
    });
    const handle=createKickSocket(42,{channelId:'99'});
    await vi.waitFor(()=>expect(MockWebSocket.instances).toHaveLength(1));
    expect(MockWebSocket.instances[0]!.url).toContain('ws-us2.pusher.com/app/freshkey123');
    expect(MockWebSocket.instances[0]!.url).not.toContain('32cbd69e4b950bf97679');
    handle.close();
  });
});
