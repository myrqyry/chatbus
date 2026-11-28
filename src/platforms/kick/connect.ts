import type { KickChatConnection, KickConnectOptions, KickResolvedChannel } from './types';
import { resolveKickChannel } from './channel';
import { normalizeKickEvent } from './normalize';
import { fetchKickRecentMessages } from './history';
import type { ChatEvent } from '../../types/chat';
import { parseKickPusherFrame } from './protocol';
import { createKickSocket } from './socket';
import { createKickPollTracker } from './polls';

export async function connectKickChat(options: KickConnectOptions): Promise<KickChatConnection> {
  const channelName = options.channel.trim();
  if (!channelName) throw new Error('Kick channel name must not be empty');

  let channel: KickResolvedChannel;
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
    const resolver = options.resolveChannel ?? ((name: string, signal?: AbortSignal) =>
      resolveKickChannel(name, { signal }));
    channel = await resolver(channelName, options.signal);
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
  // Reuse the channel lookup already performed; an absent field is unknown,
  // only an explicit null or a valid livestream record establishes state.
  const raw=channel.raw;
  const initial=raw&&typeof raw==='object'&&'livestream' in raw?raw.livestream:undefined;
  const snapshotTime=Date.now();
  let snapshotPending=true;
  const emitSnapshot=()=>{
    if(!snapshotPending||closed)return;snapshotPending=false;
    if(streamLive!==undefined)return;
    const context={channelName:channel.channelName,channelId:channel.channelId??String(channel.chatroomId),now:()=>snapshotTime};
    const snapshot=initial===null?{channelName:context.channelName,channelId:context.channelId,type:'stream-offline' as const,platform:'kick' as const,timestamp:snapshotTime,data:{source:'kick-native'}}:normalizeKickEvent({type:'StreamerIsLive',data:{livestream:initial}},context);
    if(snapshot&&acceptStream(snapshot))receiveRealtime({...snapshot,origin:'replay'});
  };
  const socket = createKickSocket(channel.chatroomId, {
    ...options.socket,
    channelId: channel.channelId,
    onStateChange: state=>{options.onStateChange?.(state);if(state==='connected')emitSnapshot();},
    onError: options.onError,
    onMessage: (frame) => {
      const parsed = parseKickPusherFrame(frame);
      if (!parsed) return;
      const event = parsed.type==='PollUpdate'||parsed.type==='PollDelete'?polls.receive(parsed):normalizeKickEvent(parsed, {
        channelName: channel.channelName,
        channelId: channel.channelId ?? String(channel.chatroomId),
        emotes: options.getEmotes?.() ?? options.emotes,
      });
      if (event && acceptStream(event)) receiveRealtime(event);
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
