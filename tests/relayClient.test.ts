import {describe,it,expect,vi} from 'vitest';
import {connectChatbusRelay} from '../src/relay/client';

class MockWebSocket extends EventTarget {
  static OPEN=1;
  static instances:MockWebSocket[]=[];
  readyState=0;
  sent:string[]=[];
  constructor(readonly url:string){super();MockWebSocket.instances.push(this);queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
  send(value:string){this.sent.push(value);}
  close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
  packet(value:unknown){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
}

describe('Chatbus relay browser client',()=>{
  it('connects same-origin, sends only platform/target, and forwards state/events/errors',async()=>{
    MockWebSocket.instances=[];
    const events:any[]=[];const states:string[]=[];const errors:string[]=[];
    const connection=await connectChatbusRelay({
      platform:'kick',target:'nickwhite',baseUrl:'http://localhost:3000/app',
      WebSocketImpl:MockWebSocket as unknown as typeof WebSocket,
      onEvent:event=>events.push(event),onStateChange:state=>states.push(state),onError:error=>errors.push(error.message),
    });
    const ws=MockWebSocket.instances[0]!;
    expect(ws.url).toBe('ws://localhost:3000/api/chatbus/live');
    expect(JSON.parse(ws.sent[0]!)).toEqual({type:'connect',protocol:1,platform:'kick',target:'nickwhite'});
    ws.packet({type:'state',state:'connected'});
    ws.packet({type:'event',event:{type:'message',platform:'kick',timestamp:1}});
    ws.packet({type:'error',message:'provider sad'});
    expect(states).toEqual(['connected']);
    expect(events).toEqual([{type:'message',platform:'kick',timestamp:1}]);
    expect(errors).toEqual(['provider sad']);
    connection.close();
  });

  it('rejects an already aborted connection without opening a socket',async()=>{
    MockWebSocket.instances=[];
    const controller=new AbortController();controller.abort();
    await expect(connectChatbusRelay({
      platform:'kick',target:'x',baseUrl:'http://localhost:3000',signal:controller.signal,
      WebSocketImpl:MockWebSocket as unknown as typeof WebSocket,onEvent:vi.fn(),
    })).rejects.toMatchObject({name:'AbortError'});
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('settles an aborted handshake and ignores late open and event callbacks',async()=>{
    MockWebSocket.instances=[];
    const controller=new AbortController(),onEvent=vi.fn();
    const pending=connectChatbusRelay({
      platform:'kick',target:'x',baseUrl:'http://localhost:3000',signal:controller.signal,
      WebSocketImpl:MockWebSocket as unknown as typeof WebSocket,onEvent,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({name:'AbortError'});
    const ws=MockWebSocket.instances[0]!;
    ws.packet({type:'event',event:{type:'message',platform:'kick',timestamp:1}});
    expect(ws.sent).toEqual([]);
    expect(onEvent).not.toHaveBeenCalled();
  });

});
