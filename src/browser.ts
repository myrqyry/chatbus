/** Public, credential-free transports that have been exercised in a web
 * browser. Do not advertise a Node connector or an unverified CORS path.
 * Applications can retain their own renderers and use a relay for the rest. */
import {connectTwitchIrcChat,type TwitchIrcConnectOptions} from './platforms/twitch/irc';
import {fetchChannelEmotesDetailed} from './emotes/loader';
import type {ChatPlatform} from './types/chat';

export const browserPublicPlatforms = ['twitch'] as const;
export type BrowserPublicPlatform = typeof browserPublicPlatforms[number];
type Platform = Exclude<ChatPlatform,'custom'>;
type Options = TwitchIrcConnectOptions & {platform?:Platform};

export function supportsBrowserPublicChat(platform:unknown):platform is BrowserPublicPlatform {
 return browserPublicPlatforms.some(item=>item===platform);
}
function requireDirect(platform:Platform) {
 if(!supportsBrowserPublicChat(platform))throw new Error(platform+' requires a compatible Chatbus relay for public chat');
}
/** Same transport/loader seam used by local hosts. No external script or
 * credential injection. The caller owns the connection handle. */
export function createBrowserChatSource(){
 return {
  connect({platform='twitch',...options}:Options){
   requireDirect(platform);
   return connectTwitchIrcChat(options);
  },
  async emotes(channel:string,platform:Platform='twitch'){
   requireDirect(platform);
   return fetchChannelEmotesDetailed(channel);
  },
 };
}
export {connectTwitchIrcChat,fetchChannelEmotesDetailed};
export {toSocialSignal} from './social/signal';
export type {ChatEvent,ChatConnectionState} from './types/chat';
export type {EmoteSet} from './types/emotes';
