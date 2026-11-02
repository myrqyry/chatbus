import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {connectKickChat} from '../src/platforms/kick/connect';

class MockWebSocket {
  static instances:MockWebSocket[]=[];
  readonly sent:string[]=[];
  onopen:((event:Event)=>void)|null=null;
  onmessage:((event:MessageEvent<unknown>)=>void)|null=null;
  onerror:((event:Event)=>void)|null=null;
  onclose:((event:CloseEvent)=>void)|null=null;
  constructor(readonly url:string){MockWebSocket.instances.push(this);}
  send(data:string){this.sent.push(data);}
  close(){this.onclose?.({} as CloseEvent);}
  emitOpen(){this.onopen?.({} as Event);}
  emitMessage(data:string){this.onmessage?.({data} as MessageEvent<unknown>);}
}

const channel={channelName:'example',channelId:'99',chatroomId:42};
const historyMessage=(id:string,content:string,created_at:string)=>({
  id,chat_id:99,user_id:1,content,created_at,sender:{id:1,username:'viewer',identity:{badges:[]}},
});
const realtimeFrame=(id:string,content:string)=>JSON.stringify({push:{channel:'chatrooms.42.v2',pub:{data:{
  event:'App\\Events\\ChatMessageEvent',data:JSON.stringify({
    id,chatroom_id:42,content,created_at:'2026-11-02T22:30:00Z',sender:{id:1,username:'viewer',identity:{badges:[]}},
  }),
}}}});

describe('Kick initial history + realtime handoff',()=>{
  beforeEach(()=>{MockWebSocket.instances=[];vi.stubGlobal('WebSocket',MockWebSocket);});
  afterEach(()=>vi.unstubAllGlobals());

  it('buffers realtime during history, emits history oldest-first, dedupes overlap, then streams normally',async()=>{
    let resolveHistory!:(response:Response)=>void;
    const history=new Promise<Response>(resolve=>{resolveHistory=resolve;});
    vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request)=>{
      const url=String(input);
      if(url.endsWith('/api/v2/channels/99/messages'))return history;
      if(url.endsWith('/api/v1/realtime/auth/connection'))return new Response(JSON.stringify({data:{token:'guest-token'}}),{status:200});
      if(url.includes('/api/v1/realtime/'))return new Response(JSON.stringify({data:{connections:[
        {provider:'centrifugo',credentials:{url:'wss://kick.test/socket'}},
      ]}}),{status:200});
      throw new Error('unexpected '+url);
    }));
    const events:any[]=[];
    const connection=await connectKickChat({
      channel:'example',resolveChannel:async()=>channel,emitInitialHistory:true,initialHistoryLimit:20,
      onEvent:event=>events.push(event),
    });
    await vi.waitFor(()=>expect(MockWebSocket.instances).toHaveLength(1));
    const ws=MockWebSocket.instances[0]!;ws.emitOpen();
    const connect=JSON.parse(ws.sent[0]!);ws.emitMessage(JSON.stringify({id:connect.id,connect:{ping:25}}));
    const subscriptions=ws.sent.slice(1).map(item=>JSON.parse(item));
    for(const item of subscriptions)ws.emitMessage(JSON.stringify({id:item.id,subscribe:{}}));
    ws.emitMessage(realtimeFrame('dup','overlap realtime'));
    expect(events).toHaveLength(0);

    resolveHistory(new Response(JSON.stringify({data:{messages:[
      historyMessage('dup','overlap history','2026-11-02T22:29:59Z'),
      historyMessage('old','older','2026-11-02T22:29:58Z'),
    ]}}),{status:200}));
    await vi.waitFor(()=>expect(events.map(event=>event.message?.id)).toEqual(['old','dup']));

    ws.emitMessage(realtimeFrame('new','after history'));
    expect(events.map(event=>event.message?.id)).toEqual(['old','dup','new']);
    connection.close();
  });

  it('keeps realtime flowing if the optional history request fails',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request)=>{
      const url=String(input);
      if(url.endsWith('/api/v2/channels/99/messages'))return new Response('nope',{status:503});
      if(url.endsWith('/api/v1/realtime/auth/connection'))return new Response(JSON.stringify({data:{token:'guest-token'}}),{status:200});
      if(url.includes('/api/v1/realtime/'))return new Response(JSON.stringify({data:{connections:[
        {provider:'centrifugo',credentials:{url:'wss://kick.test/socket'}},
      ]}}),{status:200});
      throw new Error('unexpected '+url);
    }));
    const events:any[]=[];
    const connection=await connectKickChat({channel:'example',resolveChannel:async()=>channel,emitInitialHistory:true,onEvent:event=>events.push(event)});
    await vi.waitFor(()=>expect(MockWebSocket.instances).toHaveLength(1));
    const ws=MockWebSocket.instances[0]!;ws.emitOpen();const connect=JSON.parse(ws.sent[0]!);
    ws.emitMessage(JSON.stringify({id:connect.id,connect:{ping:25}}));
    for(const item of ws.sent.slice(1).map(value=>JSON.parse(value)))ws.emitMessage(JSON.stringify({id:item.id,subscribe:{}}));
    ws.emitMessage(realtimeFrame('live','still works'));
    await vi.waitFor(()=>expect(events.map(event=>event.message?.id)).toEqual(['live']));
    connection.close();
  });
});
