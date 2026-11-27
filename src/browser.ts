/** Public read-only browser transports; applications retain their renderer
 * and use a relay for providers without a verified browser-native path. */
import {connectTwitchIrcChat,type TwitchIrcConnectOptions} from './platforms/twitch/irc';
import {fetchChannelEmotesDetailed} from './emotes/loader';
import {connectKickChat} from './platforms/kick/connect';
import {resolveKickChannel} from './platforms/kick/channel';
import {loadKickPublicTransport,type KickPublicPusher} from './platforms/kick/public-transport';
import {fetchGlobalSevenTv,fetchKickChannelSevenTv} from './emotes/sevenTv';
import {mergeCandidates} from './emotes/registry';
import type {ChatPlatform} from './types/chat';

export const browserPublicPlatforms = ['twitch','kick'] as const;
export type BrowserPublicPlatform = typeof browserPublicPlatforms[number];
type Platform = Exclude<ChatPlatform,'custom'>;
type Options = TwitchIrcConnectOptions & {platform?:Platform};

export function supportsBrowserPublicChat(platform:unknown):platform is BrowserPublicPlatform {
 return browserPublicPlatforms.some(item=>item===platform);
}
function requireDirect(platform:Platform) {
 if(!supportsBrowserPublicChat(platform))throw new Error(platform+' requires a compatible Chatbus relay for public chat');
}
/** Same transport/loader seam used by local hosts. No user credentials. */
export function createBrowserChatSource(config:{loadKickPublicTransport?:(signal?:AbortSignal)=>Promise<KickPublicPusher>}={}){
 return {
  connect({platform='twitch',...options}:Options){
   requireDirect(platform);
   if(platform==='twitch')return connectTwitchIrcChat(options);
   const controller=new AbortController();
   let closed=false,active:{close():void}|undefined;
   const close=()=>{
    if(closed)return;
    closed=true;controller.abort();active?.close();active=undefined;
    options.signal?.removeEventListener('abort',close);
   };
   if(options.signal?.aborted){close();return {close};}
   options.signal?.addEventListener('abort',close,{once:true});
   options.onStateChange?.('connecting');
   void connectKickChat({
    ...options,signal:controller.signal,emitInitialHistory:false,
    socket:{resolvePublicPusher:config.loadKickPublicTransport??loadKickPublicTransport},
    onEvent:event=>{if(!closed)options.onEvent(event);},
    onStateChange:state=>{if(!closed)options.onStateChange?.(state);},
    onError:error=>{if(!closed)options.onError?.(error);},
   }).then(connection=>{if(closed)connection.close();else active=connection;},error=>{
    if(closed)return;
    options.onStateChange?.('error');
    options.onError?.(error instanceof Error?error:new Error('Kick browser connection failed'));
   });
   return {close};
  },
  async emotes(channel:string,platform:Platform='twitch'){
   requireDirect(platform);
   if(platform==='twitch')return fetchChannelEmotesDetailed(channel);
   const resolved=await resolveKickChannel(channel);
   const results=await Promise.all([fetchGlobalSevenTv(),...(resolved.channelId?[fetchKickChannelSevenTv(resolved.channelId)]:[])]);
   return {emotes:mergeCandidates(results.flatMap(r=>r.candidates)),complete:results.every(r=>r.status.ok)};
  },
 };
}
export {connectTwitchIrcChat,fetchChannelEmotesDetailed};
export {toSocialSignal} from './social/signal';
export type {ChatEvent,ChatConnectionState} from './types/chat';
export type {EmoteSet} from './types/emotes';
