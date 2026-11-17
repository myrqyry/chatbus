import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { createKickWebhookReceiver, attachChatbusRelayServer } from '../src/relay/server';
import { connectChatbusRelay } from '../src/relay/client';
import type { ChatEvent } from '../src/types/chat';

const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const pem=publicKey.export({type:'spki',format:'pem'}).toString();
const now=Date.parse('2026-11-17T20:00:00Z');
const subscriptions=[{subscriptionId:'sub-a',broadcasterUserId:42,target:'alpha'},{subscriptionId:'sub-b',broadcasterUserId:43,target:'beta'}];
function delivery(id='delivery-1',sub='sub-a',broadcaster=42,time=now) {
  const timestamp=new Date(time).toISOString();
  const body=JSON.stringify({message_id:id,created_at:timestamp,content:'Hello [emote:37226:KEKW]',broadcaster:{user_id:broadcaster,channel_slug:broadcaster===42?'alpha':'beta'},sender:{user_id:7,username:'viewer'}});
  const signature=sign('RSA-SHA256',Buffer.from(id+'.'+timestamp+'.'+body),privateKey).toString('base64');
  return {body,headers:{'Kick-Event-Message-Id':id,'Kick-Event-Message-Timestamp':timestamp,'Kick-Event-Signature':signature,'Kick-Event-Type':'chat.message.sent','Kick-Event-Version':'1','Kick-Event-Subscription-Id':sub}};
}
function request(d=delivery()) {return new Request('http://localhost/api/kick/webhook',{method:'POST',...d});}

describe('official webhook to existing relay',()=>{
  it('delivers signed HTTP intake to two real loopback clients, isolates channels and persists dedupe across recreation',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'chatbus-webhook-'));
    const file=join(dir,'deliveries.sqlite');
    let db=new DatabaseSync(file);
    db.exec('CREATE TABLE delivery (id TEXT PRIMARY KEY, event TEXT NOT NULL)');
    const recordDelivery=async(d:{deliveryId:string,event:ChatEvent})=>db.prepare('INSERT OR IGNORE INTO delivery VALUES (?,?)').run(d.deliveryId,JSON.stringify(d.event)).changes===1;
    let receiver=createKickWebhookReceiver({subscriptions,getPublicKey:async()=>pem,recordDelivery,now:()=>now});
    const server=createServer(async(req,res)=>{
      try {
        const init = {method:req.method,headers:req.headers as Record<string,string>,body:Readable.toWeb(req) as ReadableStream<Uint8Array>,duplex:'half'};
        const response=await receiver.handle(new Request('http://localhost/api/kick/webhook',init));
        res.writeHead(response.status);res.end(await response.text());
      }catch{res.writeHead(500);res.end();}
    });
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    const address=server.address();if(!address||typeof address==='string')throw Error('no port');
    const base='http://127.0.0.1:'+address.port;
    const relay=attachChatbusRelayServer({server,resolveConnection:req=>({platform:'kick',options:{channel:req.target}}),connect:async(spec,callbacks)=>{
      if(spec.platform!=='kick')throw Error('unsupported');
      return receiver.connect(spec.options.channel,callbacks);
    }});
    const a:ChatEvent[]=[],b:ChatEvent[]=[],other:ChatEvent[]=[];
    const clients=[];
    try{
      for(const [target,events] of [['alpha',a],['alpha',b],['beta',other]] as const){
        let ready=false;
        class LocalSocket extends WebSocket {constructor(url:string){super(url,{origin:base});}}
        clients.push(await connectChatbusRelay({platform:'kick',target,baseUrl:base,WebSocketImpl:LocalSocket as unknown as typeof globalThis.WebSocket,onEvent:e=>events.push(e),onStateChange:s=>{if(s==='connected')ready=true;}}));
        await vi.waitFor(()=>expect(ready).toBe(true));
      }
      const send=(d=delivery())=>fetch(base+'/api/kick/webhook',{method:'POST',...d});
      const responses=await Promise.all([send(),send()]);
      expect(responses.map(r=>r.status)).toEqual([204,204]);
      await vi.waitFor(()=>{expect(a).toHaveLength(1);expect(b).toHaveLength(1);});
      expect(other).toHaveLength(0);
      expect(a[0]).toEqual(b[0]);
      expect(a[0]?.message?.fragments).toContainEqual(expect.objectContaining({type:'emote',emote:expect.objectContaining({id:'37226'})}));
      expect((await send(delivery('delivery-2','sub-b',43))).status).toBe(204);
      await vi.waitFor(()=>expect(other).toHaveLength(1));
      expect(a).toHaveLength(1);
      expect(db.prepare('SELECT count(*) AS n FROM delivery').get()?.n).toBe(2);
      clients.forEach(c=>c.close());receiver.close();db.close();
      db=new DatabaseSync(file);
      receiver=createKickWebhookReceiver({subscriptions,getPublicKey:async()=>pem,recordDelivery,now:()=>now});
      const replay=vi.fn();receiver.connect('alpha',{onEvent:replay,onStateChange:vi.fn(),onError:vi.fn()});
      expect((await send()).status).toBe(204);
      expect(replay).not.toHaveBeenCalled();
      expect(db.prepare('SELECT count(*) AS n FROM delivery').get()?.n).toBe(2);
    }finally{clients.forEach(c=>c.close());receiver.close();relay.close();await new Promise<void>(r=>server.close(()=>r()));db.close();rmSync(dir,{recursive:true,force:true});}
  });
  it('rejects tampering, stale/future events, unknown registration and oversized streams before recording',async()=>{
    const recordDelivery=vi.fn(async()=>true);
    const receiver=createKickWebhookReceiver({subscriptions,getPublicKey:async()=>pem,recordDelivery,now:()=>now});
    try{
      const d=delivery();
      expect((await receiver.handle(request({...d,body:d.body+' '}))).status).toBe(401);
      for(const t of [now-301000,now+31000])expect((await receiver.handle(request(delivery('old','sub-a',42,t)))).status).toBe(401);
      expect((await receiver.handle(request(delivery('wrong','sub-a',43)))).status).toBe(401);
      expect((await receiver.handle(request(delivery('unknown','unknown',42)))).status).toBe(401);
      expect((await receiver.handle(request({...d,body:'x'.repeat(256*1024+1)}))).status).toBe(413);
      expect((await receiver.handle(new Request('http://localhost'))).status).toBe(405);
      expect(recordDelivery).not.toHaveBeenCalled();
      expect(()=>receiver.connect('unknown',{onEvent:vi.fn(),onStateChange:vi.fn(),onError:vi.fn()})).toThrow();
    }finally{receiver.close();}
  });
  it('does not fan out on storage failure and isolates a failing client',async()=>{
    const recordDelivery=vi.fn().mockRejectedValueOnce(Error('disk offline')).mockResolvedValueOnce(true);
    const receiver=createKickWebhookReceiver({subscriptions,getPublicKey:async()=>pem,recordDelivery,now:()=>now});
    const good=vi.fn(),bad=vi.fn(()=>{throw Error('client offline');});
    const error=vi.fn();
    receiver.connect('alpha',{onEvent:bad,onStateChange:vi.fn(),onError:error});
    receiver.connect('alpha',{onEvent:good,onStateChange:vi.fn(),onError:vi.fn()});
    expect((await receiver.handle(request())).status).toBe(503);
    expect(good).not.toHaveBeenCalled();
    expect((await receiver.handle(request())).status).toBe(204);
    expect(good).toHaveBeenCalledTimes(1);expect(bad).toHaveBeenCalledTimes(1);expect(error).toHaveBeenCalledTimes(1);
    receiver.close();
    expect((await receiver.handle(request())).status).toBe(503);
  });

  it('bounds chunked intake and never delivers a late persistence result to a closed receiver',async()=>{
    const recordDelivery=vi.fn();
    const receiver=createKickWebhookReceiver({subscriptions,getPublicKey:async()=>pem,recordDelivery,now:()=>now});
    try{
      let chunks=0,cancelled=false;
      const stream=new ReadableStream<Uint8Array>({
        pull(controller){chunks++;controller.enqueue(new Uint8Array(128*1024));},
        cancel(){cancelled=true;},
      });
      const headers=delivery().headers;
      const init={method:'POST',headers,body:stream,duplex:'half'};
      expect((await receiver.handle(new Request('http://localhost/api/kick/webhook',init))).status).toBe(413);
      expect(cancelled).toBe(true);
      expect(chunks).toBeLessThanOrEqual(4);
      expect(recordDelivery).not.toHaveBeenCalled();
      let persist!: (value:boolean)=>void;
      recordDelivery.mockImplementationOnce(()=>new Promise<boolean>(resolve=>{persist=resolve;}));
      const received=vi.fn(),state=vi.fn();
      receiver.connect('alpha',{onEvent:received,onStateChange:state,onError:vi.fn()});
      const pending=receiver.handle(request());
      await vi.waitFor(()=>expect(recordDelivery).toHaveBeenCalledTimes(1));
      receiver.close();
      persist(true);
      expect((await pending).status).toBe(204);
      expect(received).not.toHaveBeenCalled();
      expect(state.mock.calls).toEqual([['connected'],['disconnected']]);
    }finally{receiver.close();}
  });

});
