import {describe,expect,it,vi} from 'vitest';
import {extractKickRoleBodies,createKickRoleArtworkLoader,kickRoleImageUrl,sanitizeKickRoleBody,createKickBadgeCatalog} from '../src/index';

const body='<path fill="#123456" d="M0 0h20v20H0Z"/>';
const definition=(name:string,svg=body)=>`let x={name:"${name}",viewBox:"0 0 20 20",body:'${svg}',category:"brand-unique",owner:"kick"};`;
const chunk='https://assets.kick.com/main/_next/static/chunks/example.js?dpl=abc123';
const html='<script src="'+chunk+'"></script><script src="https://evil.invalid/x.js"></script>';

describe('runtime Kick design-system artwork',()=>{
 it('extracts exact named static vector data without executing the script',()=>{
  expect(extractKickRoleBodies(definition('ModeratorBadge')+definition('Gift250')+definition('Gift25')))
    .toEqual({moderator:body,'gift-25':body});
  expect(extractKickRoleBodies(definition('Gift1','<script>alert(1)</script>'))).toEqual({});
 });
 it('restricts SVG tags, attribute values and references to inert local artwork',()=>{
  const safe='<use xlink:href="#a" fill="url(#b)"/><defs><path id="a" d="M0 0L1 1"/><linearGradient id="b" x1="0" y1="0" x2="20" y2="20" gradientUnits="userSpaceOnUse"><stop stop-color="#abcdef" offset="1"/></linearGradient></defs>';
  expect(sanitizeKickRoleBody(safe)).toBe(safe);
  for(const invalid of ['<path onload="alert(1)" d="M0 0"/>','<use xlink:href="https://evil.invalid/a.svg#x"/>','<image href="https://evil.invalid/x"/>','<path fill="url(https://evil.invalid/x)" d="M0 0"/>','<use xlink:href="#missing"/>','<g><path d="M0 0"/></g>','<path d="M0 0"/><foreignObject/>','<!DOCTYPE svg>','<path d="M0 0" d="M1 1"/>'])
   expect(sanitizeKickRoleBody(invalid)).toBeUndefined();
  expect(kickRoleImageUrl(body)).toMatch(/^data:image\/svg\+xml,/);
 });
 it('coalesces connections, only downloads listed Kick assets, and caches successful discovery',async()=>{
  const fetcher=vi.fn(async(input:RequestInfo|URL)=>new Response(String(input)===chunk
   ?definition('ModeratorBadge')+definition('VerifiedBadge')+definition('Gift1')+definition('Gift25'):html));
  const load=createKickRoleArtworkLoader(fetcher as typeof fetch);
  const [a,b]=await Promise.all([load('example'),load('other')]);
  expect(a).toEqual({moderator:body,verified:body,'gift-1':body,'gift-25':body});
  expect(b).toEqual(a);expect(await load('third')).toEqual(a);
  expect(fetcher.mock.calls.map(c=>String(c[0]))).toEqual(['https://kick.com/example',chunk]);
 });
 it('fails softly and backs off on denied upstream requests',async()=>{
  const fetcher=vi.fn(async()=>new Response('denied',{status:403}));
  const load=createKickRoleArtworkLoader(fetcher as typeof fetch);
  expect(await load('example')).toEqual({});
  expect(await load('another')).toEqual({});
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('ignores old-channel completions and does not lose subscriber artwork on a role failure',async()=>{
  const releases=new Map<string,(v:{moderator:string})=>void>();
  const catalog=createKickBadgeCatalog(async()=>({subscriber_badges:[{months:1,badge_image:{src:'https://files.kick.com/channel_subscriber_badges/1/conversion/original-fullsize.png'}}]}),
   channel=>new Promise(r=>releases.set(channel,r)));
  const old=catalog.loadChannel('old',()=>{});
  const next=catalog.loadChannel('new',()=>{});
  const fresh='<path fill="#123abc" d="M0 0h20v20H0Z"/>';
  releases.get('new')!({moderator:fresh});await next;
  releases.get('old')!({moderator:body});await old;
  expect(catalog.resolve([{provider:'kick',id:'moderator'}])[0]?.svgBody).toBe(fresh);
  const failed=createKickBadgeCatalog(async()=>({subscriber_badges:[{months:1,badge_image:{src:'https://files.kick.com/channel_subscriber_badges/1/conversion/original-fullsize.png'}}]}),
   async()=>{throw Error('unavailable');});
  await failed.loadChannel('example',()=>{});
  expect(failed.resolve([{provider:'kick',id:'subscriber',version:'2'}])[0]?.images[0]?.url).toContain('channel_subscriber_badges/1');
  expect(failed.resolve([{provider:'kick',id:'moderator'}])).toEqual([]);
 });
 it('resolves roles through the existing catalog independently of subscriber lookup',async()=>{
  let release!:(v:{moderator:string;'gift-25':string})=>void;
  let finish!:(v:unknown)=>void;
  const updates=vi.fn();
  const catalog=createKickBadgeCatalog(()=>new Promise(r=>{finish=r}),()=>new Promise(r=>{release=r}));
  const pending=catalog.loadChannel('example',updates);
  const refs=[{provider:'kick' as const,id:'moderator'},{provider:'kick' as const,id:'sub_gifter',version:'25'}];
  expect(catalog.resolve(refs)).toEqual([]);
  release({moderator:body,'gift-25':body});
  await Promise.resolve();await Promise.resolve();
  expect(catalog.resolve(refs)).toMatchObject([{id:'moderator',svgBody:body,images:[]},{id:'sub_gifter',version:'25',svgBody:body,images:[]}]);
  expect(updates).toHaveBeenCalled();
  expect(catalog.resolve([{provider:'kick',id:'sub_gifter',version:'26'}])).toEqual([]);
  finish({subscriber_badges:[]});await pending;
  expect(catalog.health()).toBe('ready');
 });
});
