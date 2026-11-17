// Explicit, read-only live network smoke. No message content or credentials logged.
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { attachChatbusRelayServer } from '../src/relay/server.ts';
import { connectChatbusRelay } from '../src/relay/client.ts';
import { createTikTokLiveDriver, normalizeTikTokChannel, type TikTokDriver } from '../src/platforms/tiktok/index.ts';

const channel=normalizeTikTokChannel(process.argv[2] ?? '');
const server=createServer();
let driver:(TikTokDriver & {isConnected?:boolean})|undefined;
let released:Promise<void>|undefined;
const relay=attachChatbusRelayServer({
  server,resolveConnection(request){
    if(request.platform!=='tiktok'||normalizeTikTokChannel(request.target)!==channel)throw Error('Unexpected smoke target');
    return {platform:'tiktok',options:{channel,createDriver:async name=>{
      driver=await createTikTokLiveDriver(name);
      const target=driver;
      return {
        on:target.on.bind(target),off:target.off.bind(target),connect:target.connect.bind(target),
        disconnect(){released=target.disconnect();return released;},
      };
    }}};
  }
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address();
assert.ok(address&&typeof address!=='string');
const origin='http://127.0.0.1:'+address.port;
class LocalSocket extends WebSocket {constructor(url:string){super(url,{origin});}}
const states:string[]=[],counts:Record<string,number>={},errors:string[]=[];
let connection:Awaited<ReturnType<typeof connectChatbusRelay>>|undefined;
try{
  connection=await connectChatbusRelay({
    platform:'tiktok',target:channel,baseUrl:origin,WebSocketImpl:LocalSocket as unknown as typeof globalThis.WebSocket,
    onStateChange:state=>states.push(state),
    onEvent:event=>{assert.equal(event.platform,'tiktok');assert.equal(event.origin,'live');counts[event.type]=(counts[event.type]??0)+1;},
    onError:error=>errors.push(error.message),
  });
  const deadline=Date.now()+27000;
  while(Date.now()<deadline&&!errors.length&&!states.includes('disconnected')&&!(states.includes('connected')&&(counts.message??0)>0)){
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.ok(states.includes('connected'),'upstream never confirmed readiness');
  assert.ok((counts.message??0)>0,'no live messages observed');
  connection.close();
  const closeDeadline=Date.now()+5000;
  while(!released&&Date.now()<closeDeadline)await new Promise(resolve=>setTimeout(resolve,50));
  assert.ok(released,'relay did not release upstream');
  await released;
  assert.equal(driver?.isConnected,false,'provider remained connected');
  console.log(JSON.stringify({channel,states,counts,errors,upstreamDisconnected:driver?.isConnected===false}));
}finally{
  connection?.close();relay.close();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
}
