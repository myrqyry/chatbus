/** Public Pusher app metadata, not a user token or a relay. The Pages
 * publisher obtains it from Kick's current anonymous negotiation API. */
export interface KickPublicPusher {appKey:string;cluster:string}
export const KICK_PUBLIC_TRANSPORT_URL='https://myrqyry.github.io/chatbus/kick-public-transport.json';
export function validatePublicPusher(value:unknown):KickPublicPusher{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid Kick public Pusher metadata');
 const v=value as Record<string,unknown>;
 if(typeof v.appKey!=='string'||!(/^[a-z0-9]{8,80}$/i.test(v.appKey))||
    typeof v.cluster!=='string'||!(/^[a-z0-9-]{1,20}$/i.test(v.cluster)))throw Error('Invalid Kick public Pusher metadata');
 return {appKey:v.appKey,cluster:v.cluster};
}
export function parseKickPublicTransport(value:unknown,now=Date.now()):KickPublicPusher{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid Kick public transport descriptor');
 const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['schema','provider','appKey','cluster','observedAt'].includes(k))||
    v.schema!==1||v.provider!=='pusher'||typeof v.observedAt!=='string')throw Error('Invalid Kick public transport descriptor');
 const age=now-Date.parse(v.observedAt);
 if(!Number.isFinite(age)||age>48*3600000||age< -5*60000)throw Error('Kick public transport descriptor is stale');
 return validatePublicPusher(v);
}
export async function loadKickPublicTransport(signal?:AbortSignal,fetcher:typeof fetch=fetch,now=Date.now):Promise<KickPublicPusher>{
 const controller=new AbortController();
 const abort=()=>controller.abort();
 if(signal?.aborted)abort();
 signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(abort,5000);
 try{
  const response=await fetcher(KICK_PUBLIC_TRANSPORT_URL,{signal:controller.signal,credentials:'omit',redirect:'error',cache:'no-store'});
  if(!response.ok||Number(response.headers.get('content-length'))>2048)throw Error('Kick public transport descriptor unavailable');
  const body=await response.text();
  if(body.length>2048)throw Error('Kick public transport descriptor too large');
  return parseKickPublicTransport(JSON.parse(body),now());
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
