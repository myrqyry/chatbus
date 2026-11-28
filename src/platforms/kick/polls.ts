import type {ChatEvent} from '../../types/chat';
import type {KickNormalizeContext,KickProtocolEvent} from './types';

const record=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const text=(v:unknown,max:number)=>typeof v==='string'&&v.trim()&&v.length<=max?v.trim():undefined;
const count=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const id=(v:unknown)=>count(v)?String(v):text(v,128);
let nextTracker=0;
/** One active native poll per connected channel. Provider frames can omit an
 * ID entirely; the engagement ID is a local session key, not a provider ID. */
export function createKickPollTracker(context:KickNormalizeContext,now=context.now??Date.now){
 const namespace='kick-local-poll:'+now()+':'+(++nextTracker)+':';
 let sequence=0;
 let active:{id:string;signature:string;title:string;deadline:number;providerId?:string}|undefined;
 const event=(data:Record<string,unknown>,timestamp:number):ChatEvent=>({platform:'kick',channelId:context.channelId,channelName:context.channelName,type:'poll',origin:'live',timestamp,data:{source:'kick-native',...data}});
 return {
  receive(frame:KickProtocolEvent):ChatEvent|null{
   const timestamp=now();
   if(frame.type==='PollDelete'){
    if(!active)return null;
    const providerId=id(frame.data.poll_id??frame.data.id);
    if(providerId&&active.providerId&&providerId!==active.providerId)return null;
    const removed=active;active=undefined;
    // A deletion is not evidence of a winning choice or final counts.
    return event({id:removed.id,phase:'end',title:removed.title,status:'removed'},timestamp);
   }
   if(frame.type!=='PollUpdate')return null;
   const p=record(frame.data.poll),title=text(p.title,160),remaining=p.remaining;
   if(!title||!Array.isArray(p.options)||p.options.length<2||p.options.length>10||!count(remaining)||remaining>86400)return null;
   const choices:{id:string;title:string;votes?:number}[]=[];
   for(const value of p.options){
    const option=record(value),key=id(option.id),label=text(option.label,100);
    if(!key||!label||choices.some(c=>c.id===key))return null;
    choices.push({id:key,title:label,...(count(option.votes)?{votes:option.votes}:{})});
   }
   const signature=JSON.stringify([title,choices.map(c=>[c.id,c.title])]),providerId=id(p.id);
   const expires=timestamp+remaining*1000;
   const display=count(p.result_display_duration)?Math.min(p.result_display_duration,3600)*1000:30000;
   if(!active||active.signature!==signature||timestamp>active.deadline||(providerId&&active.providerId&&providerId!==active.providerId)){
    active={id:namespace+(++sequence),signature,title,deadline:expires+display,providerId};
   }else{
    active.deadline=expires+display;
    if(providerId)active.providerId=providerId;
   }
   return event({id:active.id,phase:'progress',title,choices,ends_at:new Date(expires).toISOString()},timestamp);
  }
 };
}
