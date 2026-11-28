import type { KickChatConnection, KickConnectOptions, KickResolvedChannel } from './types';
import { resolveKickChannel } from './channel';
import { normalizeKickEvent } from './normalize';
import { fetchKickRecentMessages } from './history';
import type { ChatEvent } from '../../types/chat';
import { parseKickPusherFrame } from './protocol';
import { createKickSocket,kickReconnectDelay } from './socket';
import {HttpError,isAbortError} from '../../network/fetch';
import { createKickPollTracker } from './polls';

const abortError=()=>new DOMException('The operation was aborted.','AbortError');
const retryable=(e:unknown)=>e instanceof HttpError?e.status===408||e.status===429||e.status>=500:e instanceof TypeError||isAbortError(e);
function retryWait(ms:number,signal?:AbortSignal){
 return new Promise<void>((resolve,reject)=>{
  if(signal?.aborted){reject(abortError());return;}
  const cleanup=()=>signal?.removeEventListener('abort',cancel);
  const timer=setTimeout(()=>{cleanup();resolve();},ms);
  const cancel=()=>{clearTimeout(timer);cleanup();reject(abortError());};
  signal?.addEventListener('abort',cancel,{once:true});
 });
}
export async function connectKickChat(options: KickConnectOptions): Promise<KickChatConnection> {
  const channelName = options.channel.trim();
  if (!channelName) throw new Error('Kick channel name must not be empty');

  if(options.signal?.aborted)throw abortError();
  const resolver=options.resolveChannel??((name:string,signal?:AbortSignal)=>resolveKickChannel(name,{signal}));
  let channel: KickResolvedChannel;
  let snapshotTime=Date.now();
  if (options.chatroomId !== undefined) {
    if (!Number.isInteger(options.chatroomId) || options.chatroomId <= 0) {
      throw new Error('Kick chatroom id must be a positive integer');
    }
    channel = {
      channelName,
      channelId: options.channelId,
      chatroomId: options.chatroomId,
    };
  } else {
    let attempts=0;
    for(;;){
      if(options.signal?.aborted)throw abortError();
      try{snapshotTime=Date.now();channel=await resolver(channelName,options.signal);break;}
      catch(error){
        if(options.signal?.aborted)throw abortError();
        if(!options.retryInitialLookup||!retryable(error))throw error;
        options.onStateChange?.('reconnecting');
        options.onError?.(error instanceof Error?error:new Error('Kick channel lookup failed'));
        const delay=kickReconnectDelay(Math.min(attempts++,5));
        await retryWait(error instanceof HttpError&&error.status===429?Math.max(30000,delay):delay,options.signal);
      }
    }
  }

  if (options.signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }

  let closed = false;
  let historyPending = options.emitInitialHistory === true && Boolean(channel.channelId);
  const historyController = new AbortController();
  const buffered: ChatEvent[] = [];
  const maxBufferedEvents = 500;
  const seenMessageIds = new Set<string>();
  const seenGiftTransactions = new Set<string>();
  const seenRedemptions = new Set<string>();
  const remember = (id: string) => {
    seenMessageIds.add(id);
    while (seenMessageIds.size > 500) {
      const oldest = seenMessageIds.values().next().value as string | undefined;
      if (oldest === undefined) break;
      seenMessageIds.delete(oldest);
    }
  };
  const deliver = (event: ChatEvent) => {
    if (closed) return;
    const id = event.type === 'message' ? event.message?.id : undefined;
    if (id && seenMessageIds.has(id)) return;
    if (id) remember(id);
    if (event.type==='donation'&&event.id) {
      if (seenGiftTransactions.has(event.id)) return;
      seenGiftTransactions.add(event.id);
      if (seenGiftTransactions.size>2048) seenGiftTransactions.delete(seenGiftTransactions.values().next().value!);
    }
    if (event.type==='reward-redemption'&&event.id) {
      if (seenRedemptions.has(event.id)) return;
      seenRedemptions.add(event.id);
      if (seenRedemptions.size>2048) seenRedemptions.delete(seenRedemptions.values().next().value!);
    }
    options.onEvent(event);
  };
  const receiveRealtime = (event: ChatEvent) => {
    if (closed) return;
    if (historyPending) {
      buffered.push(event);
      // History is optional. Never let it hold an unbounded live backlog.
      if (buffered.length >= maxBufferedEvents) {
        historyController.abort();
        flushRealtime();
      }
    } else deliver(event);
  };
  const flushRealtime = () => {
    historyPending = false;
    if (closed) { buffered.length = 0; return; }
    for (const event of buffered.splice(0)) deliver(event);
  };

  const polls=createKickPollTracker({channelName:channel.channelName,channelId:channel.channelId??String(channel.chatroomId)});
  const retiredStreams=new Set<string>();
  let streamId:string|undefined,streamLive:boolean|undefined;
  const retire=(id:string|undefined)=>{
    if(!id)return;retiredStreams.add(id);
    if(retiredStreams.size>32)retiredStreams.delete(retiredStreams.values().next().value!);
  };
  const acceptStream=(event:ChatEvent)=>{
    if(event.type!=='stream-online'&&event.type!=='stream-offline')return true;
    const id=(event.data as {streamId?:string}|undefined)?.streamId,live=event.type==='stream-online';
    if(id&&retiredStreams.has(id))return false;
    if(live===streamLive&&id===streamId)return false;
    if(!live&&streamLive&&streamId&&id&&streamId!==id)return false;
    if(streamLive&&streamId!==id)retire(streamId);
    if(!live)retire(id);
    streamId=id;streamLive=live;return true;
  };
  // Reuse the initial lookup. On later ready handshakes refresh just once,
  // never interpret a transport disconnect as a broadcaster going offline.
  let snapshotPending=true,streamRevision=0;
  let refreshController:AbortController|undefined;
  const cancelRefresh=()=>{refreshController?.abort();refreshController=undefined;};
  const emitSnapshot=(resolved:KickResolvedChannel,timestamp:number)=>{
    const raw=resolved.raw;
    const value=raw&&typeof raw==='object'&&'livestream' in raw?raw.livestream:undefined;
    const context={channelName:channel.channelName,channelId:channel.channelId??String(channel.chatroomId),now:()=>timestamp};
    const snapshot:ChatEvent|null=value===null?{channelName:context.channelName,channelId:context.channelId,type:'stream-offline',platform:'kick',timestamp,data:{source:'kick-native'}}:normalizeKickEvent({type:'StreamerIsLive',data:{livestream:value}},context);
    if(!snapshot)return;
    const id=(snapshot.data as {streamId?:string}|undefined)?.streamId;
    // A fresh same-state snapshot is useful to viewers that lost state.
    if(snapshot.type==='stream-online'&&id&&retiredStreams.has(id))return;
    if(streamLive&&streamId!==id)retire(streamId);
    streamLive=snapshot.type==='stream-online';streamId=id;
    receiveRealtime({...snapshot,origin:'replay'});
  };
  const onConnected=()=>{
    if(closed||options.signal?.aborted)return;
    if(snapshotPending){
      snapshotPending=false;
      if(streamLive===undefined)emitSnapshot(channel,snapshotTime);
      return;
    }
    if(options.chatroomId!==undefined&&!options.resolveChannel)return;
    cancelRefresh();
    const controller=new AbortController();refreshController=controller;
    const revision=streamRevision,timestamp=Date.now();
    void resolver(channelName,controller.signal).then(resolved=>{
      if(closed||controller.signal.aborted||refreshController!==controller||revision!==streamRevision)return;
      if(resolved.channelName.toLowerCase()!==channel.channelName.toLowerCase()||resolved.channelId!==channel.channelId||resolved.chatroomId!==channel.chatroomId)return;
      emitSnapshot(resolved,timestamp);
    }).catch(()=>{/* Optional status refresh must not interrupt chat. */}).finally(()=>{
      if(refreshController===controller)refreshController=undefined;
    });
  };
  const socket = createKickSocket(channel.chatroomId, {
    ...options.socket,
    channelId: channel.channelId,
    onStateChange: state=>{if(state!=='connected')cancelRefresh();options.onStateChange?.(state);if(state==='connected')onConnected();},
    onError: options.onError,
    onMessage: (frame) => {
      const parsed = parseKickPusherFrame(frame);
      if (!parsed) return;
      const event = parsed.type==='PollUpdate'||parsed.type==='PollDelete'?polls.receive(parsed):normalizeKickEvent(parsed, {
        channelName: channel.channelName,
        channelId: channel.channelId ?? String(channel.chatroomId),
        emotes: options.getEmotes?.() ?? options.emotes,
      });
      if (event && acceptStream(event)) {
        if(event.type==='stream-online'||event.type==='stream-offline'){streamRevision++;cancelRefresh();}
        receiveRealtime(event);
      }
    },
  });

  if (historyPending) {
    void fetchKickRecentMessages(channel, {
      limit: options.initialHistoryLimit,
      signal: historyController.signal,
    }).then(events => {
      if (closed || !historyPending) return;
      for (const event of events) deliver(event);
      flushRealtime();
    }, () => flushRealtime());
  }

  const close = () => {
    if (closed) return;
    closed = true;
    historyController.abort();
    cancelRefresh();
    buffered.length = 0;
    socket.close();
  };
  options.signal?.addEventListener('abort', close, { once: true });

  return {
    channel,
    close: () => {
      options.signal?.removeEventListener('abort', close);
      close();
    },
  };
}
