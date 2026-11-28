/** Public read-only browser transports; applications retain their renderer
 * and use a relay for providers without a verified browser-native path. */
import {connectTwitchIrcChat,type TwitchIrcConnectOptions} from './platforms/twitch/irc';
import {fetchChannelEmotesDetailed} from './emotes/loader';
import {connectYouTubeChat} from './platforms/youtube/connect';
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
/** Same transport/loader seam used by local hosts. YouTube optionally takes a caller-owned restricted API key. */
export function createBrowserChatSource(config:{loadKickPublicTransport?:(signal?:AbortSignal)=>Promise<KickPublicPusher>;youtubeApiKey?:string}={}){
 const youtubeKey=config.youtubeApiKey?.trim();
 const requireAvailable=(platform:Platform)=>{
  if(platform==='youtube'){if(!youtubeKey)throw Error('YouTube requires your own Data API key for browser chat');return;}
  requireDirect(platform);
 };
 return {
  connect({platform='twitch',...options}:Options){
   requireAvailable(platform);
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
   const callbacks={
    signal:controller.signal,
    onEvent:(event:import('./types/chat').ChatEvent)=>{if(!closed)options.onEvent(event);},
    onStateChange:(state:import('./types/chat').ChatConnectionState)=>{if(!closed)options.onStateChange?.(state);},
    onError:(error:Error)=>{if(!closed)options.onError?.(platform==='youtube'?new Error(error.message.replaceAll(youtubeKey!,'[redacted]')):error);},
   };
   const pending=platform==='youtube'
    ?connectYouTubeChat({videoId:options.channel,apiKey:youtubeKey,apiKeyHeader:true,minPollMs:10000,emitInitialHistory:false,...callbacks})
    :connectKickChat({...options,retryInitialLookup:true,emitInitialHistory:false,socket:{resolvePublicPusher:config.loadKickPublicTransport??loadKickPublicTransport},...callbacks});
   void pending.then(connection=>{if(closed)connection.close();else active=connection;},error=>{
    if(closed)return;
    options.onStateChange?.('error');
    const message=error instanceof Error?error.message:platform+' browser connection failed';
    options.onError?.(new Error(platform==='youtube'?message.replaceAll(youtubeKey!,'[redacted]'):message));
   });
   return {close};
  },
  async emotes(channel:string,platform:Platform='twitch'){
   requireAvailable(platform);
   if(platform==='twitch')return fetchChannelEmotesDetailed(channel);
   if(platform==='youtube')return {emotes:{},complete:true};
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
