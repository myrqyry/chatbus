/** Narrow, inert subset of Kick's observed design-system SVG bodies.
 * Never inject upstream markup into the document or execute downloaded JS.
 * Consumers can use an image-only data URL after validating again. */
export type KickRoleKey='moderator'|'verified'|'gift-1'|'gift-25';
export type KickRoleBodies=Partial<Record<KickRoleKey,string>>;
/** Match only provider-confirmed roles and exact known gifting milestones. */
export function kickRoleArtworkKey(ref:{provider?:string;id?:string;version?:string}):KickRoleKey|undefined{
 if(ref.provider!=='kick')return;
 const id=ref.id?.toLowerCase();
 if(id==='moderator'||id==='verified')return id;
 if(id==='sub_gifter'&&ref.version==='1')return 'gift-1';
 if(id==='sub_gifter'&&ref.version==='25')return 'gift-25';
}

const number=/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?%?$/;
const id=/^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const color=/^(?:#[0-9a-fA-F]{3,8}|none|currentColor)$/;
const paint=/^url\(#([A-Za-z][A-Za-z0-9_-]{0,79})\)$/;
const tags:Record<string,readonly string[]>={
 path:['id','d','fill','fill-rule','clip-rule'],
 use:['xlink:href','href','fill'],
 defs:[],
 linearGradient:['id','x1','x2','y1','y2','gradientUnits'],
 stop:['stop-color','offset'],
};
export function sanitizeKickRoleBody(value:unknown):string|undefined{
 if(typeof value!=='string'||!value.length||value.length>4096)return;
 const stack:string[]=[];
 const ids=new Map<string,string>(),refs:{id:string;kind:string}[]=[];
 let pos=0,nodes=0,visible=false;
 while(pos<value.length){
  const remaining=value.slice(pos);
  const space=/^\s+/.exec(remaining);
  if(space){pos+=space[0].length;continue;}
  const close=/^<\/([A-Za-z]+)\s*>/.exec(remaining);
  if(close){
   if(stack.pop()!==close[1])return;
   pos+=close[0].length;continue;
  }
  const open=/^<([A-Za-z]+)((?:\s+[A-Za-z][A-Za-z0-9:-]*="[^"<>&]*")*)\s*(\/?)>/.exec(remaining);
  if(!open||!Object.hasOwn(tags,open[1]!)||++nodes>40)return;
  const tag=open[1]!,parent=stack.at(-1),attrs=new Map<string,string>();
  if(parent==='defs'?!['path','linearGradient'].includes(tag):
     parent==='linearGradient'?tag!=='stop':
     parent?true:!['defs','path','use'].includes(tag))return;
  for(const match of open[2]!.matchAll(/\s+([A-Za-z][A-Za-z0-9:-]*)="([^"<>&]*)"/g)){
   const key=match[1]!,v=match[2]!;
   if(attrs.has(key)||!tags[tag]!.includes(key))return;
   attrs.set(key,v);
   if(key==='id'){if(!id.test(v)||ids.has(v))return;ids.set(v,tag);}
   else if(key==='d'){if(!v.length||v.length>2500||!/^[MmLlHhVvCcSsQqTtAaZz0-9.,+\-eE\s]+$/.test(v))return;}
   else if(key==='fill'){
    const ref=paint.exec(v);if(ref)refs.push({id:ref[1]!,kind:'linearGradient'});
    else if(!color.test(v))return;
   }
   else if(key==='href'||key==='xlink:href'){
    if(!v.startsWith('#')||!id.test(v.slice(1)))return;
    refs.push({id:v.slice(1),kind:'path'});
   }
   else if(key==='stop-color'){if(!color.test(v))return;}
   else if(key==='fill-rule'||key==='clip-rule'){if(v!=='evenodd'&&v!=='nonzero')return;}
   else if(key==='gradientUnits'){if(v!=='userSpaceOnUse'&&v!=='objectBoundingBox')return;}
   else if(!number.test(v))return;
  }
  if(tag==='path'&&!attrs.has('d'))return;
  if(tag==='use'&&(Number(attrs.has('href'))+Number(attrs.has('xlink:href'))!==1))return;
  if(tag==='linearGradient'&&!attrs.has('id'))return;
  if(tag==='stop'&&!attrs.has('stop-color'))return;
  if(!parent&&(tag==='path'||tag==='use'))visible=true;
  if(!open[3]){
   if(tag!=='defs'&&tag!=='linearGradient')return;
   stack.push(tag);
  }
  pos+=open[0].length;
 }
 if(stack.length||!visible||refs.some(r=>ids.get(r.id)!==r.kind))return;
 return value;
}
export function kickRoleImageUrl(body:unknown):string|undefined{
 const safe=sanitizeKickRoleBody(body);
 if(!safe)return;
 return 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 20 20" fill="none">'+safe+'</svg>');
}
