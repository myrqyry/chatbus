import type {ChatEvent,ChatUser} from '../../types/chat';
import {normalizeKickEvent} from './normalize';
import type {KickNormalizeContext} from './types';
export const KICK_OFFICIAL_EVENTS=['chat.message.sent','channel.followed','channel.subscription.new','channel.subscription.renewal','channel.subscription.gifts','channel.reward.redemption.updated','livestream.status.updated','livestream.metadata.updated','moderation.banned','kicks.gifted'] as const;
export type KickOfficialEventType=typeof KICK_OFFICIAL_EVENTS[number];
const row=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const str=(v:unknown,n=128)=>typeof v==='string'&&v.trim()&&v.length<=n?v.trim():undefined;
const id=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0?String(v):str(v);
const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:undefined;
const person=(v:unknown):ChatUser|undefined=>{
 const r=row(v),username=str(r.username,64),userId=id(r.user_id);
 return r.is_anonymous!==true&&username?{platform:'kick',username,displayName:username,id:userId}:undefined;
};
const time=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&Date.parse(v)>=0?Date.parse(v):undefined;
/** Converts documented official v1 payloads. Authentication is the caller's responsibility. */
export function normalizeKickOfficialEvent(type:string,payload:unknown,delivery:{id:string;timestamp:number;broadcasterId:string},context:KickNormalizeContext={}):ChatEvent|null{
 const p=row(payload),b=row(p.broadcaster),channelId=id(b.user_id),channelName=str(b.channel_slug,64);
 if(!channelId||channelId!==delivery.broadcasterId||!channelName||!Number.isSafeInteger(delivery.timestamp)||delivery.timestamp<0)return null;
 const base={id:delivery.id,platform:'kick' as const,channelId,channelName,origin:'live' as const,timestamp:time(p.created_at)??delivery.timestamp};
 const source='kick-webhook';
 switch(type){
  case 'chat.message.sent':{
   const sender=person(p.sender),messageId=str(p.message_id),identity=row(row(p.sender).identity);
   if(!sender?.id||!messageId||typeof p.content!=='string'||p.content.length>16384)return null;
   const event=normalizeKickEvent({type:'ChatMessage',data:{id:messageId,chatroom_id:0,content:p.content,created_at:new Date(base.timestamp).toISOString(),sender:{id:sender.id,username:sender.username,identity:{color:str(identity.username_color,16),badges:Array.isArray(identity.badges)?identity.badges.slice(0,64):undefined}},metadata:{original_message:{id:str(row(p.replies_to).message_id)}}}},{...context,channelId,channelName});
   return event?{...event,data:{source}}:null;
  }
  case 'channel.followed':{
   const user=person(p.follower);return user?{...base,type:'follow',user,data:{source}}:null;
  }
  case 'channel.subscription.new':
  case 'channel.subscription.renewal':{
   const user=person(p.subscriber);return user?{...base,type:'subscription',user,data:{source,subscriptionPhase:type.endsWith('.renewal')?'resub':'start',durationMonths:count(p.duration)}}:null;
  }
  case 'channel.subscription.gifts':{
   const anonymous=row(p.gifter).is_anonymous===true,user=person(p.gifter);
   if(!anonymous&&!user||!Array.isArray(p.giftees)||!p.giftees.length||p.giftees.length>10000)return null;
   if(!p.giftees.every(g=>!!id(row(g).user_id)))return null;
   return {...base,type:'gift-subscription',user,data:{source,subscriptionPhase:'gift',anonymous,count:p.giftees.length}};
  }
  case 'channel.reward.redemption.updated':{
   const reward=row(p.reward),redemptionId=str(p.id),user=person(p.redeemer),status=p.status;
   if(!redemptionId||!user||!str(reward.id)||!['pending','accepted','rejected'].includes(String(status)))return null;
   // Pending is a redemption; accepted/rejected are status evidence only.
   return {...base,type:status==='pending'?'reward-redemption':'reward-update',user,data:{source,redemptionId,status,userInput:p.user_input,reward:{id:reward.id,title:reward.title,cost:reward.cost}}};
  }
  case 'kicks.gifted':{
   const gift=row(p.gift),amount=count(gift.amount),user=person(p.sender);
   if(amount===undefined||amount===0||!user)return null;
   return {...base,type:'donation',user,data:{source,kickGift:{amount,name:gift.name,type:gift.type,tier:gift.tier,quote:gift.message,pinnedSeconds:gift.pinned_time_seconds}}};
  }
  case 'livestream.status.updated':
   return typeof p.is_live==='boolean'?{...base,type:p.is_live?'stream-online':'stream-offline',data:{source,title:str(p.title,200),startedAt:str(p.started_at),endedAt:str(p.ended_at)}}:null;
  case 'livestream.metadata.updated':{
   const m=row(p.metadata);
   return typeof m.title==='string'?{...base,type:'channel-update',data:{source,title:str(m.title,200),language:str(m.language,32),category:str(row(m.category).name,100)}}:null;
  }
  case 'moderation.banned':{
   const user=person(p.banned_user),m=row(p.metadata);
   if(!user||!(m.expires_at===null||time(m.expires_at)!==undefined))return null;
   return {...base,type:m.expires_at===null?'user-ban':'user-timeout',user,data:{source,expiresAt:m.expires_at}};
  }
  default:return null;
 }
}
