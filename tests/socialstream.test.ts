// @vitest-environment node
import {afterEach,describe,expect,it,vi} from 'vitest';
import {WebSocketServer} from 'ws';
import {normalizeSocialStreamMessage} from '../src/platforms/socialstream/normalize';
import {connectSocialStream} from '../src/platforms/socialstream/connect';

describe('Social Stream Ninja public feed normalization',()=>{
  it('keeps native platform identity separate from upstream source and safely handles HTML and images',()=>{
    const message=normalizeSocialStreamMessage({
      type:'youtube',chatname:'ExampleViewer',chatmessage:'Hi <b>you</b> &amp; <img alt="Kappa" src="https://images.example/kappa.png">',
      textonly:false,meta:{messageId:'message-7',channelId:'UCabc'},
      chatbadges:[{src:'https://example.org/badge.png',label:'Moderator'}, {src:'javascript:alert(1)',label:'bad'}],
    },{fallbackId:'unused',receivedAtMs:123});
    expect(message?.origin).toBeUndefined();
    expect(message).toMatchObject({type:'message',platform:'youtube',
      message:{id:'ssn:youtube:message-7',text:'Hi you & Kappa',user:{username:'ExampleViewer',
        badges:[{name:'Moderator',images:[{url:'https://example.org/badge.png'}]}]}}});
    expect(message?.message?.fragments).toMatchObject([
      {type:'text',text:'Hi you & '},
      {type:'emote',text:'Kappa',emote:{url:'https://images.example/kappa.png'}},
    ]);
    expect(JSON.stringify(message)).not.toContain('javascript:');
  });
  it('preserves safe native emote images as structured fragments, rejecting untrusted URLs',()=>{
    const event=normalizeSocialStreamMessage({type:'twitch',chatname:'Bob',
      chatmessage:'hey <img src="https://cdn.example/emote.webp" alt="Pog"> and <img src="javascript:alert(1)" alt="Nope">',
      meta:{messageId:'rich-1'}},{receivedAtMs:20});
    expect(event?.message?.fragments).toEqual([
      {type:'text',text:'hey '},
      {type:'emote',text:'Pog',emote:expect.objectContaining({provider:'custom',code:'Pog',url:'https://cdn.example/emote.webp'}),overlays:[],modifiers:[]},
      {type:'text',text:' and Nope'},
    ]);
    expect(JSON.stringify(event)).not.toContain('javascript:');
  });
  it('does not convert currency or turn an ordinary tipped chat into two events',()=>{
    const message=normalizeSocialStreamMessage({type:'twitch',chatname:'Viewer',chatmessage:'hello',
      textonly:true,hasDonation:'500 Bits',meta:{messageId:'mid-1'}},{fallbackId:'none',receivedAtMs:1});
    expect(message).toMatchObject({type:'message',data:{source:'socialstream',displayAmount:'500 Bits'}});
    const donation=normalizeSocialStreamMessage({type:'youtube',event:'superchat',
      chatname:'Viewer',chatmessage:'hi',hasDonation:'¥500',meta:{messageId:'paid'}},
      {fallbackId:'none',receivedAtMs:1});
    expect(donation).toMatchObject({type:'donation',platform:'youtube',data:{displayAmount:'¥500',sourceType:'superchat'}});
    expect(JSON.stringify(donation)).not.toContain('USD');
  });
  it('preserves literal text, rejects unsupported envelopes, and marks synthetic IDs as synthetic',()=>{
    const ordinary=normalizeSocialStreamMessage({type:'rumble',chatname:'Alice',textonly:true,
      chatmessage:'<b>literal</b>',chatimg:'file:///secret'},
      {fallbackId:'in-2',receivedAtMs:12});
    expect(ordinary).toMatchObject({platform:'custom',message:{id:'ssn:rumble:local:in-2',
      text:'<b>literal</b>'},data:{sourcePlatform:'rumble',syntheticId:true}});
    expect(normalizeSocialStreamMessage({type:'twitch',chatmessage:'missing user'}, {fallbackId:'x'})).toBeNull();
    expect(normalizeSocialStreamMessage({callback:{get:'secret'}},{fallbackId:'x'})).toBeNull();
  });
});

describe('Social Stream Ninja optional WebSocket transport',()=>{
  let server:WebSocketServer|undefined;
  afterEach(async()=>{await new Promise<void>(ok=>server?.close(()=>ok())??ok());server=undefined;});
  it('subscribes to channel four, dedupes source IDs, reconnects, and stops cleanly',async()=>{
    server=new WebSocketServer({port:0});
    const port=(server.address() as {port:number}).port;
    const sockets:import('ws').WebSocket[]=[];
    server.on('connection',socket=>{
      sockets.push(socket);
      socket.send(JSON.stringify({type:'youtube',chatname:'Alice',textonly:true,chatmessage:'hey',
        meta:{messageId:'msg-1'}}));
      socket.send(JSON.stringify({type:'youtube',chatname:'Alice',textonly:true,chatmessage:'hey',
        meta:{messageId:'msg-1'}}));
    });
    const events:any[]=[],states:string[]=[];
    const feed=connectSocialStream({sessionId:'localtest1',endpoint:'ws://127.0.0.1:'+port,
      reconnectBaseMs:30,onEvent:e=>events.push(e),onStateChange:s=>states.push(s)});
    await vi.waitFor(()=>expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({origin:'live',data:{source:'socialstream'}});
    expect(states).toContain('connected');
    sockets[0]?.close();
    await vi.waitFor(()=>expect(sockets.length).toBe(2));
    expect(events).toHaveLength(1);
    feed.close();
    expect(feed.state()).toBe('disconnected');
    expect(states.at(-1)).toBe('disconnected');
    await new Promise(ok=>setTimeout(ok,80));
    expect(sockets.length).toBe(2);
  });
  it('rejects insecure remote hosts and never exposes session secrets in errors',()=>{
    expect(()=>connectSocialStream({sessionId:'sensitive1',
      endpoint:'ws://nonlocal.example',onEvent:()=>{}})).toThrow(/secure|endpoint/i);
    expect(()=>connectSocialStream({sessionId:'bad/secret',onEvent:()=>{}})).toThrow(/session/i);
  });
});
