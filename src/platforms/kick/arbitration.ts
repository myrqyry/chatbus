import type {ChatEvent} from '../../types/chat';
import type {KickOfficialEventType} from './official-events';

export interface KickTransportBinding {
 channelName:string;
 /** Official broadcaster user ID, NOT the native channel ID. */
 broadcasterId:string;
 nativeChannelId:string;
}
export interface KickTransportArbiter {
 setNativeConnected(connected:boolean):void;
 /** Only host-confirmed healthy official subscriptions, not requested grants. */
 setOfficialCoverage(types:readonly KickOfficialEventType[]):void;
 accept(transport:'native'|'official',event:ChatEvent):ChatEvent|null;
}
/** One per verified channel binding. No fuzzy actor/time-based deduplication. */
export function createKickTransportArbiter(options:KickTransportBinding&{now?:()=>number}):KickTransportArbiter{
 const slug=options.channelName.trim().toLowerCase();
 if(!/^[a-z0-9_-]{1,64}$/.test(slug)||!/^\d{1,20}$/.test(options.broadcasterId)||!/^\d{1,20}$/.test(options.nativeChannelId))throw Error('Invalid Kick transport binding');
 const now=options.now??Date.now;
 let nativeConnected=false,coverage=new Set<KickOfficialEventType>();
 const seen=new Map<string,number>();
 const maxAge=600000,maxEntries=10000;
 const isKickGift=(event:ChatEvent)=>event.type==='donation'&&event.data!==null&&typeof event.data==='object'&&'kickGift' in event.data&&Boolean(event.data.kickGift);
 const owner=(event:ChatEvent):'native'|'official'|null=>{
  switch(event.type){
   case 'message':case 'user-ban':case 'user-timeout':return nativeConnected?'native':'official';
   case 'subscription':return coverage.has('channel.subscription.new')&&coverage.has('channel.subscription.renewal')?'official':nativeConnected?'native':'official';
   case 'stream-online':case 'stream-offline':return coverage.has('livestream.status.updated')?'official':nativeConnected?'native':'official';
   case 'reward-redemption':return coverage.has('channel.reward.redemption.updated')?'official':nativeConnected?'native':'official';
   case 'gift-subscription':return coverage.has('channel.subscription.gifts')?'official':nativeConnected?'native':'official';
   case 'donation':if(isKickGift(event))return coverage.has('kicks.gifted')?'official':nativeConnected?'native':'official';return null;
   default:return null;
  }
 };
 return {
  setNativeConnected(connected){nativeConnected=connected;},
  setOfficialCoverage(types){coverage=new Set(types);},
  accept(transport,event){
   if(event.platform!=='kick'||event.channelName?.trim().toLowerCase()!==slug)return null;
   const expected=transport==='official'?options.broadcasterId:options.nativeChannelId;
   if(event.channelId!==expected||event.message&&(event.message.platform!=='kick'||event.message.channelId!==expected||event.message.channelName?.toLowerCase()!==slug))return null;
   // Native history and socket events may precede the connected callback.
   // Preserve native fallback unless official explicitly owns that paid family.
   const preferred=owner(event);
   if(transport==='official'&&preferred==='native')return null;
   if(transport==='native'&&preferred==='official'&&(
     event.type==='subscription'&&coverage.has('channel.subscription.new')&&coverage.has('channel.subscription.renewal')||
     event.type==='gift-subscription'&&coverage.has('channel.subscription.gifts')||
     isKickGift(event)&&coverage.has('kicks.gifted')||
     event.type==='reward-redemption'&&coverage.has('channel.reward.redemption.updated')||
     (event.type==='stream-online'||event.type==='stream-offline')&&coverage.has('livestream.status.updated')
   ))return null;
   if(event.type==='message'&&event.message){
    const id=event.message.id,current=now();
    if(!id||id.length>256)return null;
    for(const [key,expiry] of seen){if(expiry<=current)seen.delete(key);else break;}
    if(seen.has(id))return null;
    if(seen.size>=maxEntries){const oldest=seen.keys().next().value;if(oldest!==undefined)seen.delete(oldest);}
    seen.set(id,current+maxAge);
   }
   if(transport==='native')return event;
   return {...event,channelId:options.nativeChannelId,channelName:slug,
    ...(event.message?{message:{...event.message,channelId:options.nativeChannelId,channelName:slug}}:{})};
  }
 };
}
