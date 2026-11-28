/** Dedicated loopback HTTP boundary. TLS is terminated by an explicitly configured reverse proxy. */
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {createKickWebhookReceiver,type KickWebhookKeyCache,type KickWebhookSubscription} from './webhook';
import type {KickDeliveryStore} from './delivery-store';
import type {KickRegisteredSubscription} from './subscriptions';
import {KICK_OFFICIAL_EVENTS} from './official-events';
import type {ChatEvent} from '../../types/chat';
export interface KickSubscriptionRegistry {
 resolve(id:string):KickWebhookSubscription|undefined;
 replaceBroadcaster(broadcasterId:string,rows:readonly KickRegisteredSubscription[]):void;
}
const validBroadcaster=(id:string)=>/^[1-9][0-9]{0,15}$/.test(id)&&Number.isSafeInteger(Number(id));
/** Host-only input: populate exclusively from an authorized app's verified API readback. */
export function createKickSubscriptionRegistry(initial:readonly KickRegisteredSubscription[]=[]):KickSubscriptionRegistry{
 let rows=new Map<string,KickRegisteredSubscription>();
 const add=(target:Map<string,KickRegisteredSubscription>,r:KickRegisteredSubscription)=>{
  if(!validBroadcaster(r.broadcasterId)||!/^[-A-Za-z0-9_]{1,128}$/.test(r.id)||r.version!=='1'||!KICK_OFFICIAL_EVENTS.includes(r.type)||target.has(r.id)||target.size>=10000)throw Error('Invalid or conflicting Kick subscription registry entry');
  target.set(r.id,Object.freeze({...r}));
 };
 for(const r of initial)add(rows,r);
 return {
  resolve(id){return rows.get(id);},
  replaceBroadcaster(broadcasterId,inventory){
   if(!validBroadcaster(broadcasterId))throw Error('Invalid Kick broadcaster');
   const next=new Map([...rows].filter(([,r])=>r.broadcasterId!==broadcasterId));
   for(const r of inventory){if(r.broadcasterId!==broadcasterId)throw Error('Foreign Kick subscription');add(next,r);}
   rows=next;
  }
 };
}
const path='/webhooks/kick',maxBody=256*1024;
const signedHeaders=['kick-event-message-id','kick-event-message-timestamp','kick-event-type','kick-event-version','kick-event-subscription-id','kick-event-signature'] as const;
export interface KickWebhookIngressOptions {
 port?:number;
 registry:KickSubscriptionRegistry;
 deliveryStore:KickDeliveryStore;
 keyCache:KickWebhookKeyCache;
 onEvent:(e:ChatEvent)=>void|Promise<void>;
 now?:()=>number;
 maxConcurrent?:number;
}
export async function createKickWebhookIngress(options:KickWebhookIngressOptions):Promise<{address:string;close():Promise<void>}>{
 const maxConcurrent=options.maxConcurrent??32;
 if(!Number.isSafeInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>128)throw Error('Invalid Kick ingress concurrency limit');
 const receiver=createKickWebhookReceiver({resolveSubscription:id=>options.registry.resolve(id),deliveryStore:options.deliveryStore,keyCache:options.keyCache,onEvent:options.onEvent,now:options.now});
 let active=0,closing=false;
 const tasks=new Set<Promise<void>>();
 const send=(res:ServerResponse,status:number,close=false)=>{
  if(res.destroyed||res.writableEnded)return;
  res.writeHead(status,{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(status===405?{Allow:'POST'}:{}),...(status===503?{'Retry-After':'5'}:{}),...(close?{Connection:'close'}:{})});res.end();
 };
 const reject=(req:IncomingMessage,res:ServerResponse,status:number)=>{send(res,status,true);req.resume();};
 const handle=async(req:IncomingMessage,res:ServerResponse)=>{
  if(req.url!==path){reject(req,res,404);return;}
  if(req.method!=='POST'){reject(req,res,405);return;}
  if(closing||active>=maxConcurrent){reject(req,res,503);return;}
  const headers:Record<string,string>={};
  const required=new Set<string>([...signedHeaders,'content-type','content-encoding']);
  for(let i=0;i<req.rawHeaders.length;i+=2){
   const key=req.rawHeaders[i]!.toLowerCase();
   if(!required.has(key))continue;
   if(Object.hasOwn(headers,key)){reject(req,res,400);return;}
   headers[key]=req.rawHeaders[i+1]!;
  }
  if(signedHeaders.some(key=>!headers[key]||headers[key]!.length>2048)){reject(req,res,400);return;}
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers['content-type']??'')||(headers['content-encoding']&&headers['content-encoding'].toLowerCase()!=='identity')){reject(req,res,415);return;}
  if(Number(req.headers['content-length']??0)>maxBody){reject(req,res,413);return;}
  active++;
  try{
   const chunks:Buffer[]=[];let size=0;
   // Absolute read deadline, independent of chunk arrival frequency.
   const timer=setTimeout(()=>{send(res,408,true);req.destroy();},10000);timer.unref();
   try{
    for await(const chunk of req){
     const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
     size+=bytes.length;
     if(size>maxBody){reject(req,res,413);return;}
     chunks.push(bytes);
    }
   }finally{clearTimeout(timer);}
   if(req.destroyed&&!req.complete)return;
   const result=await receiver.receive({headers,body:Buffer.concat(chunks,size)});
   send(res,result==='accepted'||result==='duplicate'?204:result==='invalid'?400:503);
  }catch{send(res,503,true);}finally{active--;}
 };
 const server=createServer({maxHeaderSize:16384,headersTimeout:10000,requestTimeout:15000,keepAliveTimeout:2000},(req,res)=>{
  const task=handle(req,res);tasks.add(task);void task.finally(()=>tasks.delete(task));
 });
 server.maxConnections=128;
 // Do not send 100 Continue automatically for requests rejected by the boundary.
 server.on('checkContinue',(req,res)=>{reject(req,res,417);});
 await new Promise<void>((resolve,reject)=>{
  server.once('error',reject);server.listen(options.port??0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});
 });
 const bound=server.address();if(!bound||typeof bound==='string'){server.close();throw Error('Kick ingress listen failed');}
 let closePromise:Promise<void>|undefined;
 return {address:'http://127.0.0.1:'+bound.port,close(){
  if(closePromise)return closePromise;
  closing=true;
  closePromise=(async()=>{
   const closed=new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
   server.closeIdleConnections();
   await closed;
   await Promise.allSettled([...tasks]);
  })();
  return closePromise;
 }};
}
