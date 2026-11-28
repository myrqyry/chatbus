import {HttpError} from '../../network/fetch';

const BASE='https://kick.com/api/v2/channels/';
const MAX_BYTES=1_000_000;
const MAX_PENDING=128;
const abortError=()=>new DOMException('The operation was aborted.','AbortError');

/** Bound the complete response, including the body, not just its headers. */
export async function fetchBoundedKickChannelJson(url:string,signal?:AbortSignal):Promise<unknown>{
 if(signal?.aborted)throw abortError();
 const controller=new AbortController();
 const abort=()=>controller.abort();
 signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(abort,8000);
 try{
  const response=await fetch(url,{signal:controller.signal,headers:{Accept:'application/json'}});
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw new HttpError(response.status,url);}
  if(Number(response.headers.get('content-length'))>MAX_BYTES){void response.body?.cancel().catch(()=>{});throw Error('Kick channel metadata exceeded maximum size');}
  const reader=response.body?.getReader();
  if(!reader)throw Error('Kick channel metadata had no response body');
  const chunks:Uint8Array[]=[];let total=0;
  const cancelReader=()=>{void reader.cancel().catch(()=>{});};
  controller.signal.addEventListener('abort',cancelReader,{once:true});
  try{
   while(true){
    if(controller.signal.aborted)throw abortError();
    const {done,value}=await reader.read();
    if(controller.signal.aborted)throw abortError();
    if(done)break;
    total+=value.byteLength;
    if(total>MAX_BYTES)throw Error('Kick channel metadata exceeded maximum size');
    chunks.push(value);
   }
  }finally{controller.signal.removeEventListener('abort',cancelReader);void reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

type Flight={controller:AbortController;promise:Promise<unknown>;users:number;settled:boolean};
const pending=new Map<string,Flight>();
/** Share public lookups within this runtime only; never retain completed raw state.
 * Individual cancellation only aborts the network when the final consumer leaves. */
export function loadKickChannelMetadata(channel:string,signal?:AbortSignal,fresh=false):Promise<unknown>{
 const slug=channel.trim().toLowerCase();
 if(signal?.aborted)return Promise.reject(abortError());
 const url=BASE+encodeURIComponent(slug);
 if(fresh||! /^[a-z0-9_-]{1,48}$/.test(slug))return fetchBoundedKickChannelJson(url,signal);
 let flight=pending.get(slug);
 if(!flight){
  if(pending.size>=MAX_PENDING)return fetchBoundedKickChannelJson(url,signal);
  const controller=new AbortController();
  const entry:Flight={controller,promise:fetchBoundedKickChannelJson(url,controller.signal),users:0,settled:false};
  entry.promise=entry.promise.finally(()=>{
   entry.settled=true;if(pending.get(slug)===entry)pending.delete(slug);
  });
  pending.set(slug,entry);flight=entry;
 }
 const entry=flight;entry.users++;
 return new Promise((resolve,reject)=>{
  let done=false;
  const finish=()=>{
   if(done)return false;done=true;signal?.removeEventListener('abort',cancel);
   if(--entry.users===0&&!entry.settled){
    if(pending.get(slug)===entry)pending.delete(slug);
    entry.controller.abort();
   }
   return true;
  };
  const cancel=()=>{if(finish())reject(abortError());};
  signal?.addEventListener('abort',cancel,{once:true});
  entry.promise.then(value=>{
   if(!finish())return;
   try{resolve(structuredClone(value));}catch(error){reject(error);}
  },error=>{if(finish())reject(error);});
  if(signal?.aborted)cancel();
 });
}
