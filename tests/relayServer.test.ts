// @vitest-environment node
import {createServer} from 'node:http';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {WebSocket} from 'ws';
import {attachChatbusRelayServer} from '../src/relay/server';
import type {ChatBusConnectionSpec} from '../src/bus';

const listen=(server:ReturnType<typeof createServer>)=>new Promise<number>((resolve,reject)=>{
  server.once('error',reject);server.listen(0,'127.0.0.1',()=>{
    const address=server.address();if(!address||typeof address==='string')return reject(new Error('no port'));
    resolve(address.port);
  });
});
const closeServer=(server:ReturnType<typeof createServer>)=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));

const nextPackets=(ws:WebSocket,count:number)=>new Promise<any[]>((resolve,reject)=>{
  const packets:any[]=[];const timer=setTimeout(()=>reject(new Error('packet timeout')),3000);
  ws.on('message',raw=>{packets.push(JSON.parse(String(raw)));if(packets.length>=count){clearTimeout(timer);resolve(packets);}});
});

describe('Chatbus relay server',()=>{
  const servers:ReturnType<typeof createServer>[]=[];
  afterEach(async()=>{for(const server of servers.splice(0))if(server.listening)await closeServer(server);});

  it('keeps provider options server-side and relays normalized events/state',async()=>{
    let eventSink:((event:any)=>void)|undefined;let stateSink:((state:any)=>void)|undefined;
    const resolved:ChatBusConnectionSpec={platform:'kick',options:{channel:'nickwhite'}};
    const connect=vi.fn(async(spec:ChatBusConnectionSpec,callbacks:{onEvent:(event:any)=>void;onStateChange:(state:any)=>void})=>{
      expect(spec).toBe(resolved);eventSink=callbacks.onEvent;stateSink=callbacks.onStateChange;return {close:vi.fn()};
    });
    const server=createServer();servers.push(server);const port=await listen(server);
    const relay=attachChatbusRelayServer({server,path:'/api/chatbus/live',resolveConnection:async request=>{
      expect(request).toEqual({platform:'kick',target:'nickwhite'});return resolved;
    },connect});
    const ws=new WebSocket(`ws://127.0.0.1:${port}/api/chatbus/live`,{headers:{Origin:`http://127.0.0.1:${port}`}});
    const packets=nextPackets(ws,3);
    await new Promise<void>((resolve,reject)=>{ws.once('open',()=>resolve());ws.once('error',reject);});
    ws.send(JSON.stringify({type:'connect',platform:'kick',target:'nickwhite'}));
    await vi.waitFor(()=>expect(connect).toHaveBeenCalledTimes(1));
    stateSink?.('connected');
    eventSink?.({type:'message',platform:'kick',timestamp:1,message:{id:'m1',platform:'kick',user:{platform:'kick',username:'u'},text:'hi',fragments:[{type:'text',text:'hi'}],timestamp:1}});
    expect(await packets).toEqual([
      {type:'ready',protocol:1},
      {type:'state',state:'connected'},
      expect.objectContaining({type:'event',event:expect.objectContaining({type:'message',message:expect.objectContaining({id:'m1',text:'hi'})})}),
    ]);
    ws.close();relay.close();
  });

  it('rejects cross-origin browser upgrades before a provider connection exists',async()=>{
    const connect=vi.fn();const server=createServer();servers.push(server);const port=await listen(server);
    const relay=attachChatbusRelayServer({server,path:'/api/chatbus/live',resolveConnection:async()=>({platform:'kick',options:{channel:'x'}}),connect});
    const result=await new Promise<string>(resolve=>{
      const ws=new WebSocket(`ws://127.0.0.1:${port}/api/chatbus/live`,{headers:{Origin:'https://evil.example'}});
      ws.once('unexpected-response',(_req,res)=>{resolve(String(res.statusCode));res.resume();});
      ws.once('error',()=>resolve('error'));
    });
    expect(result).toBe('403');expect(connect).not.toHaveBeenCalled();relay.close();
  });
});
