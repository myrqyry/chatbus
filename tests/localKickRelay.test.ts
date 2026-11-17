import {createServer} from 'node:http';
import {WebSocket} from 'ws';
import {describe,it,expect,vi} from 'vitest';
import {attachLocalKickRelay,resolveLocalKickRelayConnection} from '../src/relay/server';
import {getLocalChatbusRelayStatus} from '../src/relay/index';

describe('shared local Kick relay',()=>{
  it('probes compatible status, fails closed on unsupported version and preserves caller abort',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({available:true,protocol:1,platforms:['kick','kick','bad']})));
    expect(await getLocalChatbusRelayStatus(fetcher)).toEqual({available:true,protocol:1,platforms:['kick']});
    expect(fetcher).toHaveBeenCalledWith('/api/chatbus/status',expect.objectContaining({cache:'no-store',signal:expect.any(AbortSignal)}));
    expect(await getLocalChatbusRelayStatus(async()=>new Response(JSON.stringify({available:true,protocol:2,platforms:['kick']})))).toEqual({available:false,protocol:1,platforms:[]});
    const abort=new AbortController();abort.abort();
    await expect(getLocalChatbusRelayStatus(fetcher,abort.signal)).rejects.toMatchObject({name:'AbortError'});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds discovery and aborts a pending fetch',async()=>{
    vi.useFakeTimers();
    try{
      const fetcher=vi.fn((_url:RequestInfo|URL,init?:RequestInit)=>new Promise<Response>((_,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true})));
      const pending=getLocalChatbusRelayStatus(fetcher);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await pending).toEqual({available:false,protocol:1,platforms:[]});
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    }finally{vi.useRealTimers();}
  });
  it('shares validated host policy while letting each app choose history',()=>{
    expect(resolveLocalKickRelayConnection({platform:'kick',target:' NickWhite '},true)).toEqual({platform:'kick',options:{channel:'NickWhite',emitInitialHistory:true,initialHistoryLimit:20}});
    expect(resolveLocalKickRelayConnection({platform:'kick',target:'NickWhite'},false)).toEqual({platform:'kick',options:{channel:'NickWhite',emitInitialHistory:false}});
    expect(()=>resolveLocalKickRelayConnection({platform:'twitch',target:'x'},false)).toThrow(/not enabled/i);
    expect(()=>resolveLocalKickRelayConnection({platform:'kick',target:'https://example.org'},false)).toThrow(/target/i);
  });
  it('serves status and upgrade on the same local host; rejects nonlocal hosts',async()=>{
    const server=createServer((req,res)=>{if(!relay.handleStatus(req,res)){res.writeHead(404);res.end();}});
    const connect=vi.fn(async()=>({close:vi.fn()}));
    const relay=attachLocalKickRelay({server,emitInitialHistory:false,connect});
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    const address=server.address();if(!address||typeof address==='string')throw Error('no port');
    const base='http://127.0.0.1:'+address.port;
    try{
      const status=await fetch(base+'/api/chatbus/status');
      expect(status.status).toBe(200);expect(await status.json()).toMatchObject({available:true,protocol:1,platforms:['kick']});
      const denied=await new Promise<number>((resolve,reject)=>{
        const ws=new WebSocket(base.replace('http:','ws:')+'/api/chatbus/live',{headers:{Host:'public.example',Origin:'http://public.example'}});
        ws.on('error',reject);ws.on('unexpected-response',(_req,res)=>{resolve(res.statusCode!);res.resume();});
      });
      expect(denied).toBe(403);expect(connect).not.toHaveBeenCalled();
      const client=new WebSocket(base.replace('http:','ws:')+'/api/chatbus/live',{origin:base});
      await new Promise<void>((resolve,reject)=>{client.once('open',()=>resolve());client.once('error',reject);});
      client.send(JSON.stringify({type:'connect',protocol:1,platform:'kick',target:'channel'}));
      await vi.waitFor(()=>expect(connect).toHaveBeenCalledTimes(1));
      expect(connect.mock.calls[0]).toBeDefined();
      client.close();
    }finally{relay.close();await new Promise<void>(r=>server.close(()=>r()));}
  });
});
