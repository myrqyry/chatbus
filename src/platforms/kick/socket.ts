import { fetchJson } from '../../network/fetch';
import type { KickSocketHandle, KickSocketOptions } from './types';

const REALTIME_CONNECTION_URL='https://web.kick.com/api/v1/realtime/connection';
const REALTIME_AUTH_URL='https://web.kick.com/api/v1/realtime/auth/connection';
const PUSHER_VERSION='protocol=7&client=js&version=8.4.0&flash=false';
const DEFAULT_INACTIVITY_TIMEOUT_MS=90_000;
const WATCHDOG_INTERVAL_MS=5_000;
const MAX_RECONNECT_DELAY_MS=30_000;
const TOKEN_REFRESH_MIN_MS=5_000;
const TOKEN_REFRESH_LEAD_MS=15_000;

type RealtimeProvider='centrifugo'|'pusher';
interface RealtimeEndpoint {provider:RealtimeProvider;url:string}
interface PendingCentrifugo {
  kind:'connect'|'subscribe'|'refresh';
  channel?:string;
}

const isRecord=(value:unknown):value is Record<string,unknown>=>
  typeof value==='object'&&value!==null&&!Array.isArray(value);

const randomClientId=():string=>{
  if(typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function')return crypto.randomUUID();
  return 'chatbus-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
};

const negotiationBody=(clientId:string)=>({
  client:{id:clientId,type:'web'},
  capabilities:{accepted_providers:[{provider:'centrifugo'},{provider:'pusher'}]},
});

const postJson=<T>(url:string,body:unknown,signal?:AbortSignal):Promise<T>=>
  fetchJson<T>(url,{
    method:'POST',
    headers:{Accept:'application/json','Content-Type':'application/json'},
    body:JSON.stringify(body),
    signal,
  },5000,0);

const endpointFrom=(value:unknown):RealtimeEndpoint|null=>{
  const data=isRecord(value)?value.data:undefined;
  const connections=isRecord(data)?data.connections:undefined;
  if(!Array.isArray(connections))return null;
  for(const item of connections){
    if(!isRecord(item)||!isRecord(item.credentials))continue;
    const credentials=item.credentials;
    if(item.provider==='centrifugo'&&typeof credentials.url==='string'&&credentials.url.startsWith('wss://')){
      return {provider:'centrifugo',url:credentials.url};
    }
    if(item.provider==='pusher'&&typeof credentials.app_key==='string'&&/^[a-z0-9]+$/i.test(credentials.app_key)){
      const cluster=typeof credentials.cluster==='string'&&/^[a-z0-9-]+$/i.test(credentials.cluster)
        ? credentials.cluster:'us2';
      return {
        provider:'pusher',
        url:`wss://ws-${cluster}.pusher.com/app/${credentials.app_key}?${PUSHER_VERSION}`,
      };
    }
  }
  return null;
};

const tokenFrom=(value:unknown):string|null=>{
  if(!isRecord(value))return null;
  const data=isRecord(value.data)?value.data:value;
  return typeof data.token==='string'&&data.token?data.token:null;
};

const centrifugoChannels=(chatroomId:number,channelId?:string):string[]=>[
  ...(channelId?[`channel_${channelId}`,`channel.${channelId}`]:[]),
  `chatroom_${chatroomId}`,
  `chatrooms.${chatroomId}`,
  `chatrooms.${chatroomId}.v2`,
];

const pusherChannels=(chatroomId:number,channelId?:string):string[]=>[
  `chatrooms.${chatroomId}.v2`,
  ...(channelId?[`channel.${channelId}`]:[]),
];

export function kickReconnectDelay(attempt:number):number{
  const base=Math.min(1000*2**attempt,MAX_RECONNECT_DELAY_MS);
  const jittered=base*(0.75+Math.random()*0.5);
  return Math.round(Math.min(jittered,MAX_RECONNECT_DELAY_MS));
}

export function createKickSocket(
  chatroomId:number,
  options:KickSocketOptions={},
):KickSocketHandle{
  if(!Number.isInteger(chatroomId)||chatroomId<=0)throw new Error('Kick chatroom id must be a positive integer');

  let socket:WebSocket|null=null;
  let stopped=false;
  let generation=0;
  let reconnectAttempts=0;
  let reconnectTimer:ReturnType<typeof setTimeout>|null=null;
  let watchdogTimer:ReturnType<typeof setInterval>|null=null;
  let refreshTimer:ReturnType<typeof setTimeout>|null;
  let requestController:AbortController|null=null;
  let lastActivityAt=Date.now();
  let inactivityTimeoutMs=options.inactivityTimeoutMs??DEFAULT_INACTIVITY_TIMEOUT_MS;
  let nextId=1;
  let provider:RealtimeProvider|null=null;
  let pending=new Map<number,PendingCentrifugo>();
  let awaiting=new Set<string>();

  const clearTimers=()=>{
    if(reconnectTimer!==null){clearTimeout(reconnectTimer);reconnectTimer=null;}
    if(watchdogTimer!==null){clearInterval(watchdogTimer);watchdogTimer=null;}
    if(refreshTimer!==null){clearTimeout(refreshTimer);refreshTimer=null;}
  };
  const sendRaw=(value:string)=>{if(socket)socket.send(value);};
  const send=(value:unknown)=>sendRaw(JSON.stringify(value));

  const scheduleReconnect=()=>{
    if(stopped||reconnectTimer!==null)return;
    options.onStateChange?.('reconnecting');
    const delay=kickReconnectDelay(reconnectAttempts++);
    reconnectTimer=setTimeout(()=>{
      reconnectTimer=null;
      void connect();
    },delay);
  };

  const markConnected=()=>{
    reconnectAttempts=0;
    options.onStateChange?.('connected');
    options.onOpen?.();
  };

  const scheduleRefresh=(reply:Record<string,unknown>|null,clientId:string,currentGeneration:number)=>{
    if(refreshTimer!==null){clearTimeout(refreshTimer);refreshTimer=null;}
    if(reply?.expires!==true||typeof reply.ttl!=='number'||reply.ttl<=0)return;
    const delay=Math.max(reply.ttl*1000-TOKEN_REFRESH_LEAD_MS,TOKEN_REFRESH_MIN_MS);
    refreshTimer=setTimeout(()=>{
      refreshTimer=null;
      void (async()=>{
        try{
          const result=await postJson<unknown>(REALTIME_AUTH_URL,{client_id:clientId},requestController?.signal);
          if(stopped||currentGeneration!==generation||provider!=='centrifugo')return;
          const token=tokenFrom(result);
          if(!token)throw new Error('Kick realtime refresh token missing');
          const id=nextId++;
          pending.set(id,{kind:'refresh'});
          send({refresh:{token},id});
        }catch(error){
          if(stopped||currentGeneration!==generation)return;
          options.onError?.(error instanceof Error?error:new Error('Kick token refresh failed'));
          socket?.close();
        }
      })();
    },delay);
  };

  const handleCentrifugo=(data:string,clientId:string,currentGeneration:number)=>{
    lastActivityAt=Date.now();
    for(const line of data.split('\n')){
      if(!line)continue;
      if(line==='{}'){sendRaw('{}');continue;}
      let frame:unknown;
      try{frame=JSON.parse(line);}catch{continue;}
      if(!isRecord(frame))continue;
      const push=isRecord(frame.push)?frame.push:null;
      const pub=push&&isRecord(push.pub)?push.pub:null;
      const envelope=pub&&isRecord(pub.data)?pub.data:null;
      if(push&&typeof push.channel==='string'&&envelope&&typeof envelope.event==='string'){
        const raw=envelope.data;
        options.onMessage?.(JSON.stringify({
          event:envelope.event,
          data:typeof raw==='string'?raw:JSON.stringify(raw),
        }));
        continue;
      }
      const id=typeof frame.id==='number'?frame.id:null;
      if(id===null)continue;
      const request=pending.get(id);
      if(!request)continue;
      pending.delete(id);
      if(isRecord(frame.error)){
        const code=frame.error.code;
        options.onError?.(new Error(
          'Kick Centrifugo '+request.kind+' failed'+(typeof code==='number'?` (code ${code})`:''),
        ));
        if(request.kind!=='subscribe')socket?.close();
        continue;
      }
      if(request.kind==='connect'){
        const reply=isRecord(frame.connect)?frame.connect:null;
        const ping=reply&&typeof reply.ping==='number'&&reply.ping>0?reply.ping:25;
        inactivityTimeoutMs=Math.max(
          options.inactivityTimeoutMs??DEFAULT_INACTIVITY_TIMEOUT_MS,
          ping*1000+10_000,
        );
        scheduleRefresh(reply,clientId,currentGeneration);
        const channels=centrifugoChannels(chatroomId,options.channelId);
        awaiting=new Set(channels);
        for(const channel of channels){
          const subscribeId=nextId++;
          pending.set(subscribeId,{kind:'subscribe',channel});
          send({subscribe:{channel},id:subscribeId});
        }
        return;
      }
      if(request.kind==='subscribe'&&request.channel){
        awaiting.delete(request.channel);
        if(awaiting.size===0)markConnected();
        continue;
      }
      if(request.kind==='refresh'){
        scheduleRefresh(isRecord(frame.refresh)?frame.refresh:null,clientId,currentGeneration);
      }
    }
  };

  const handlePusher=(data:string)=>{
    lastActivityAt=Date.now();
    let envelope:Record<string,unknown>|null=null;
    try{
      const parsed=JSON.parse(data) as unknown;
      envelope=isRecord(parsed)?parsed:null;
    }catch{}
    if(!envelope||typeof envelope.event!=='string'){
      options.onMessage?.(data);
      return;
    }
    if(envelope.event==='pusher:connection_established'){
      let established:unknown=envelope.data;
      if(typeof established==='string'){
        try{established=JSON.parse(established);}catch{}
      }
      const timeout=isRecord(established)&&typeof established.activity_timeout==='number'
        ? established.activity_timeout*1000:0;
      inactivityTimeoutMs=Math.max(
        options.inactivityTimeoutMs??DEFAULT_INACTIVITY_TIMEOUT_MS,
        timeout?timeout+WATCHDOG_INTERVAL_MS:0,
      );
      const channels=pusherChannels(chatroomId,options.channelId);
      awaiting=new Set(channels);
      for(const channel of channels)send({event:'pusher:subscribe',data:{auth:'',channel}});
      return;
    }
    if(envelope.event==='pusher:ping'){send({event:'pusher:pong',data:{}});return;}
    if(envelope.event==='pusher:pong')return;
    if(envelope.event==='pusher_internal:subscription_succeeded'&&typeof envelope.channel==='string'){
      awaiting.delete(envelope.channel);
      if(awaiting.size===0)markConnected();
      return;
    }
    if(envelope.event.startsWith('pusher:')||envelope.event.startsWith('pusher_internal:'))return;
    options.onMessage?.(data);
  };

  const openSocket=(
    endpoint:RealtimeEndpoint,
    token:string|null,
    clientId:string,
    currentGeneration:number,
  )=>{
    if(stopped||currentGeneration!==generation)return;
    provider=endpoint.provider;
    pending.clear();
    awaiting.clear();
    lastActivityAt=Date.now();
    let current:WebSocket;
    try{current=new WebSocket(endpoint.url);}catch(error){
      options.onError?.(error instanceof Error?error:new Error('Kick WebSocket open failed'));
      scheduleReconnect();
      return;
    }
    socket=current;
    current.onopen=()=>{
      if(stopped||socket!==current||currentGeneration!==generation)return;
      lastActivityAt=Date.now();
      if(endpoint.provider==='centrifugo'){
        const id=nextId++;
        pending.set(id,{kind:'connect'});
        send({connect:{token,name:'js'},id});
      }
    };
    current.onmessage=event=>{
      if(stopped||socket!==current||currentGeneration!==generation||typeof event.data!=='string')return;
      if(endpoint.provider==='centrifugo')handleCentrifugo(event.data,clientId,currentGeneration);
      else handlePusher(event.data);
    };
    current.onerror=()=>{
      if(stopped||socket!==current)return;
      options.onStateChange?.('error');
      options.onError?.(new Error('Kick WebSocket error'));
      current.close();
    };
    current.onclose=()=>{
      if(socket===current)socket=null;
      if(stopped){options.onStateChange?.('disconnected');return;}
      pending.clear();
      awaiting.clear();
      scheduleReconnect();
    };
  };

  async function connect(){
    if(stopped)return;
    const currentGeneration=++generation;
    options.onStateChange?.(reconnectAttempts>0?'reconnecting':'connecting');
    requestController?.abort();
    const controller=new AbortController();
    requestController=controller;
    const clientId=randomClientId();
    try{
      let endpoint:RealtimeEndpoint|null=null;
      if(options.appKey){
        const base=(options.baseUrl??'wss://ws-us2.pusher.com/app').replace(/\/$/u,'');
        endpoint={provider:'pusher',url:`${base}/${options.appKey}?${PUSHER_VERSION}`};
      }else{
        const global=await postJson<unknown>(
          REALTIME_CONNECTION_URL,
          negotiationBody(clientId),
          controller.signal,
        );
        endpoint=endpointFrom(global);
        if(options.channelId){
          const channel=await postJson<unknown>(
            `https://web.kick.com/api/v1/realtime/channels/${encodeURIComponent(options.channelId)}/chat/connection`,
            negotiationBody(clientId),
            controller.signal,
          );
          endpoint=endpointFrom(channel)??endpoint;
        }
      }
      if(stopped||currentGeneration!==generation)return;
      if(!endpoint)throw new Error('Kick realtime negotiation returned no supported provider');
      let token:string|null=null;
      if(endpoint.provider==='centrifugo'){
        const auth=await postJson<unknown>(
          REALTIME_AUTH_URL,
          {client_id:clientId},
          controller.signal,
        );
        token=tokenFrom(auth);
        if(!token)throw new Error('Kick realtime auth response did not include a token');
      }
      if(stopped||currentGeneration!==generation)return;
      openSocket(endpoint,token,clientId,currentGeneration);
    }catch(error){
      if(stopped||currentGeneration!==generation||controller.signal.aborted)return;
      options.onError?.(error instanceof Error?error:new Error('Kick realtime setup failed'));
      scheduleReconnect();
    }
  }

  watchdogTimer=setInterval(()=>{
    if(stopped||!socket)return;
    if(Date.now()-lastActivityAt<=inactivityTimeoutMs)return;
    options.onError?.(new Error(`No Kick chat activity for ${inactivityTimeoutMs}ms; reconnecting`));
    socket.close();
  },Math.min(
    WATCHDOG_INTERVAL_MS,
    Math.max(Math.floor((options.inactivityTimeoutMs??DEFAULT_INACTIVITY_TIMEOUT_MS)/3),1),
  ));

  void connect();

  return {
    close:()=>{
      if(stopped)return;
      stopped=true;
      generation++;
      requestController?.abort();
      requestController=null;
      clearTimers();
      pending.clear();
      awaiting.clear();
      const current=socket;
      socket=null;
      if(current){
        current.onopen=current.onmessage=current.onerror=current.onclose=null;
        current.close();
      }
      options.onStateChange?.('disconnected');
    },
  };
}
