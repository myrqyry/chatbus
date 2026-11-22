import WebSocket from 'ws';
import type {ChatConnectionState,ChatEvent} from '../../types/chat';
import {normalizeSocialStreamMessage} from './normalize';

export interface SocialStreamConnectOptions {
  /** SSN API session identifier; configure server-side, never in an OBS source URL. */
  sessionId:string;
  /** Defaults to the SSN relay; only secure remote and explicit loopback endpoints allowed. */
  endpoint?:string;
  onEvent:(event:ChatEvent)=>void;
  onStateChange?:(state:ChatConnectionState)=>void;
  onError?:(error:Error)=>void;
  reconnectBaseMs?:number;
  dedupeLimit?:number;
  /** Test or trusted local transport override. */
  webSocketFactory?:(url:string)=>WebSocket;
}
export interface SocialStreamConnection {
  close():void;
  state():ChatConnectionState;
}
const WS_OPEN=WebSocket.OPEN;
const MAX_MESSAGE_BYTES=256*1024;

export function socialStreamChatUrl(endpoint:string,sessionId:string):string {
  if(!/^[a-z0-9_-]{4,128}$/i.test(sessionId))throw new TypeError('Invalid Social Stream session identifier');
  let base:URL;
  try{base=new URL(endpoint);}catch{throw new TypeError('Invalid Social Stream endpoint');}
  const local=['localhost','127.0.0.1','[::1]'].includes(base.hostname);
  if(base.username||base.password||base.hash||base.search||base.pathname!=='/' ||
    (base.protocol!=='wss:' && !(local&&base.protocol==='ws:')))
    throw new TypeError('Social Stream requires a secure WebSocket endpoint except local loopback');
  base.pathname='/join/'+encodeURIComponent(sessionId)+'/4';
  return base.toString();
}

/** Read-only, opt-in SSN session listener. No control channel or cross-platform assumptions. */
export function connectSocialStream(options:SocialStreamConnectOptions):SocialStreamConnection {
  const url=socialStreamChatUrl(options.endpoint??'wss://io.socialstream.ninja/',options.sessionId);
  const limit=options.dedupeLimit??2048;
  if(!Number.isSafeInteger(limit)||limit<1||limit>100000)throw new RangeError('Invalid Social Stream dedupe limit');
  const baseDelay=options.reconnectBaseMs??500;
  if(!Number.isSafeInteger(baseDelay)||baseDelay<10||baseDelay>60000)
    throw new RangeError('Invalid Social Stream reconnect interval');
  const makeSocket=options.webSocketFactory??((address:string)=>new WebSocket(address,{maxPayload:MAX_MESSAGE_BYTES}));
  const seen=new Set<string>();
  let closed=false,attempt=0,sequence=0;
  let socket:WebSocket|null=null;
  let retry:ReturnType<typeof setTimeout>|null=null;
  let state:ChatConnectionState='connecting';
  options.onStateChange?.(state);
  const transition=(next:ChatConnectionState)=>{
    if(closed||state===next)return;
    state=next;options.onStateChange?.(next);
  };
  const report=(reason:string)=>{
    if(!closed)options.onError?.(new Error(reason)); // never include session URL
  };
  const schedule=()=>{
    if(closed||retry)return;
    transition('reconnecting');
    const delay=Math.min(30000,baseDelay*2**Math.min(attempt++,6));
    retry=setTimeout(()=>{retry=null;open();},delay);
  };
  function open(){
    if(closed)return;
    let ws:WebSocket;
    try{ws=makeSocket(url);}catch{report('Social Stream WebSocket connection failed');schedule();return;}
    socket=ws;
    ws.on('open',()=>{
      if(closed||socket!==ws)return;
      attempt=0;transition('connected');
      // SSN sends chat to channel 4 only when its explicit publish setting is enabled.
      // A connected socket does not establish that any capture source is enabled.
    });
    ws.on('message',raw=>{
      if(closed||socket!==ws||ws.readyState!==WS_OPEN)return;
      const text=String(raw);
      if(Buffer.byteLength(text)>MAX_MESSAGE_BYTES){report('Social Stream frame exceeded size limit');ws.close();return;}
      let value:unknown;
      try{value=JSON.parse(text);}catch{return;}
      const event=normalizeSocialStreamMessage(value,{receivedAtMs:Date.now(),
        fallbackId:String(++sequence)});
      if(!event)return;
      if(event.data&&typeof event.data==='object'&&
        (event.data as {syntheticId?:boolean}).syntheticId!==true){
        if(seen.has(event.id!))return;
        seen.add(event.id!);
        while(seen.size>limit)seen.delete(seen.values().next().value!);
      }
      options.onEvent({...event,origin:'live'});
    });
    ws.on('error',()=>{
      if(!closed&&socket===ws)report('Social Stream WebSocket transport error');
    });
    ws.on('close',()=>{
      if(closed||socket!==ws)return;
      socket=null;
      schedule();
    });
  }
  open();
  return {
    state:()=>state,
    close(){
      if(closed)return;
      closed=true;
      if(retry)clearTimeout(retry);
      retry=null;
      const previous=socket;socket=null;
      if(previous)previous.close();
      state='disconnected';
      options.onStateChange?.('disconnected');
    },
  };
}
