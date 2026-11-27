import {sanitizeKickRoleBody,type KickRoleBodies} from './role-svg';

const roles={ModeratorBadge:'moderator',VerifiedBadge:'verified',Gift1:'gift-1',Gift25:'gift-25'} as const;
const complete=(art:KickRoleBodies)=>Object.values(roles).every(key=>!!art[key]);
/** The observed static definitions are data literals, not functions. Match exact
 * names and the observed 20px viewbox. Fail closed if the structure changes. */
export function extractKickRoleBodies(script:string):KickRoleBodies{
 const result:KickRoleBodies={};
 for(const [name,key] of Object.entries(roles)){
  const pattern=new RegExp('(?:^|[,{])\\s*name:"'+name+'",\\s*viewBox:"0 0 20 20",\\s*body:\\x27([^\\x27]{1,4096})\\x27');
  const body=sanitizeKickRoleBody(pattern.exec(script)?.[1]);
  if(body)result[key]=body;
 }
 return result;
}
const MAX_TOTAL=20*1024*1024,MAX_CHUNK=2*1024*1024,MAX_HTML=2*1024*1024;
const initialHints=['2viwo1_5a_lbi.js','3vczt2licy1cu.js','3ks_1-4ya93c3.js'];
const validChunk=(raw:string):URL|undefined=>{
 try{
  const u=new URL(raw);
  if(u.origin!=='https://assets.kick.com'||u.username||u.password||u.hash||
     !/^\/main\/_next\/static\/chunks\/[A-Za-z0-9_~.-]{1,100}\.js$/.test(u.pathname)||
     (u.search&&!/^\?dpl=[A-Za-z0-9_-]{1,80}$/.test(u.search)))return;
  return u;
 }catch{return;}
};
function chunkUrls(html:string):URL[]{
 const urls=new Map<string,URL>();
 for(const match of html.matchAll(/<script\b[^>]{0,2048}\bsrc="([^"]{1,512})"/gi)){
  const url=validChunk(match[1]!);
  if(url)urls.set(url.href,url);
  if(urls.size>=100)break;
 }
 return [...urls.values()];
}
async function boundedText(fetcher:typeof fetch,url:string,max:number,signal:AbortSignal,budget:{remaining:number}):Promise<string>{
 const r=await fetcher(url,{signal,redirect:'error'});
 if(!r.ok||!r.body){await r.body?.cancel().catch(()=>{});throw new Error('Kick artwork HTTP '+r.status);}
 const advertised=Number(r.headers.get('content-length'));
 if(advertised>max){await r.body.cancel().catch(()=>{});throw new Error('Kick artwork response too large');}
 const reader=r.body.getReader(),decoder=new TextDecoder();
 let size=0,out='';
 try{
  while(true){
   const {done,value}=await reader.read();if(done)break;
   size+=value.byteLength;budget.remaining-=value.byteLength;
   if(size>max||budget.remaining<0)throw new Error('Kick artwork download budget exceeded');
   out+=decoder.decode(value,{stream:true});
  }
  return out+decoder.decode();
 }finally{await reader.cancel().catch(()=>{});}
}
export function createKickRoleArtworkLoader(fetcher:typeof fetch=fetch,now=Date.now){
 let cache:KickRoleBodies={},expires=0,pending:Promise<KickRoleBodies>|undefined;
 let hints=initialHints;
 async function discover(channel:string):Promise<KickRoleBodies>{
  const signal=AbortSignal.timeout(18000),budget={remaining:MAX_TOTAL};
  const html=await boundedText(fetcher,'https://kick.com/'+encodeURIComponent(channel),MAX_HTML,signal,budget);
  const urls=chunkUrls(html);
  const basename=(u:URL)=>u.pathname.split('/').at(-1)!;
  const known=urls.filter(u=>hints.includes(basename(u)));
  const rest=urls.filter(u=>!hints.includes(basename(u)));
  const ordered=[...known,...rest];
  const found:KickRoleBodies={},newHints=new Set<string>();
  let cursor=0;
  const worker=async()=>{
   while(!complete(found)&&!signal.aborted&&budget.remaining>0&&cursor<ordered.length){
    const url=ordered[cursor++]!;
    try{
     const text=await boundedText(fetcher,url.href,MAX_CHUNK,signal,budget);
     const extracted=extractKickRoleBodies(text);
     if(Object.keys(extracted).length){
      Object.assign(found,extracted);newHints.add(basename(url));
     }
    }catch{/* unavailable chunks are not retried or bypassed */}
   }
  };
  // Known chunks normally resolve all roles in the first batch. A changed
  // deployment is discovered from the actual page, with a shared byte/time cap.
  await Promise.all(Array.from({length:Math.min(3,ordered.length)},worker));
  if(newHints.size)hints=[...newHints];
  return found;
 }
 return function load(channel:string):Promise<KickRoleBodies>{
  if(!/^[a-z0-9_-]{1,48}$/i.test(channel))return Promise.resolve({});
  if(pending)return pending;
  if(now()<expires)return Promise.resolve(cache);
  pending=discover(channel).then(found=>{
   cache=found;expires=now()+(complete(found)?6*60*60*1000:10*60*1000);
   return cache;
  },()=>{cache={};expires=now()+5*60*1000;return cache;}).finally(()=>{pending=undefined;});
  return pending;
 };
}
/** One coalesced catalog per server/function instance, never per message. */
export const loadKickRoleArtwork=createKickRoleArtworkLoader();
