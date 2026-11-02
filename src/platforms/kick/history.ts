import {fetchJson} from '../../network/fetch';
import type {ChatEvent} from '../../types/chat';
import {normalizeKickEvent} from './normalize';
import type {KickChatMessagePayload,KickResolvedChannel,KickSenderIdentity} from './types';

const HISTORY_LIMIT_DEFAULT=20;
const HISTORY_LIMIT_MAX=50;
const isRecord=(value:unknown):value is Record<string,unknown>=>
  typeof value==='object'&&value!==null&&!Array.isArray(value);

export interface KickHistoryOptions {
  limit?:number;
  signal?:AbortSignal;
}

const normalizeLimit=(value:number|undefined):number=>{
  if(value===undefined)return HISTORY_LIMIT_DEFAULT;
  if(!Number.isInteger(value)||value<1||value>HISTORY_LIMIT_MAX)
    throw new RangeError(`Kick history limit must be between 1 and ${HISTORY_LIMIT_MAX}`);
  return value;
};

const historyPayload=(value:unknown,channel:KickResolvedChannel):KickChatMessagePayload|null=>{
  if(!isRecord(value)||typeof value.id!=='string'||typeof value.content!=='string'||
    typeof value.created_at!=='string'||!isRecord(value.sender))return null;
  const sender=value.sender;
  if((typeof sender.id!=='string'&&typeof sender.id!=='number')||typeof sender.username!=='string')return null;
  const identity=isRecord(sender.identity)?sender.identity as KickSenderIdentity:undefined;
  return {
    id:value.id,
    chatroom_id:channel.chatroomId,
    content:value.content,
    ...(typeof value.type==='string'?{type:value.type}:{}),
    created_at:value.created_at,
    sender:{
      id:sender.id,username:sender.username,
      ...(typeof sender.slug==='string'?{slug:sender.slug}:{}),
      ...(identity?{identity}:{}),
    },
    ...(value.metadata!==undefined?{metadata:value.metadata}:{}),
  };
};

/** Fetch Kick's current web-client recent-chat snapshot. This is an internal
 * endpoint, so callers must treat failure as optional enrichment and keep the
 * realtime socket usable. Messages are returned oldest-first for display. */
export async function fetchKickRecentMessages(
  channel:KickResolvedChannel,
  options:KickHistoryOptions={},
):Promise<ChatEvent[]> {
  if(!channel.channelId)return [];
  const limit=normalizeLimit(options.limit);
  const response=await fetchJson<unknown>(
    `https://kick.com/api/v2/channels/${encodeURIComponent(channel.channelId)}/messages`,
    {headers:{Accept:'application/json'},signal:options.signal},
    5000,0,
  );
  const data=isRecord(response)&&isRecord(response.data)?response.data:null;
  const messages=data&&Array.isArray(data.messages)?data.messages:[];
  return messages.slice(0,limit).flatMap(value=>{
    const payload=historyPayload(value,channel);
    if(!payload)return [];
    const event=normalizeKickEvent({type:'ChatMessage',data:payload},{
      channelName:channel.channelName,
      channelId:channel.channelId,
    });
    return event?[event]:[];
  }).reverse();
}
