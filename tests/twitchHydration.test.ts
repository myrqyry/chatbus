import {describe,it,expect,vi} from 'vitest';
import {fetchTwitchBroadcasterState} from '../src/platforms/twitch/broadcaster-state';
import {toSocialSignal} from '../src/index';
const auth={userId:'1',clientId:'client',accessToken:'token',scopes:['channel:read:polls','channel:read:predictions','channel:read:goals','channel:read:charity','channel:read:hype_train','channel:read:redemptions']};
describe('read-only broadcaster hydration',()=>{
 it('fetches only authorized active families, filters historical results and projects current state without live alerts',async()=>{
  const now=Date.parse('2026-11-27T12:00:00Z');
  const fetcher=vi.fn(async(url:string)=>{
   const path=new URL(url).pathname;
   const data=path.endsWith('/polls')?[{id:'p',status:'ACTIVE',title:'Choose',choices:[{id:'a',title:'A',votes:4}],started_at:'2026-11-27T11:59:00Z',duration:120},{id:'old',status:'COMPLETED'}]:
   path.endsWith('/predictions')?[{id:'pr',status:'LOCKED',title:'Win?',outcomes:[]}]:
   path.endsWith('/goals')?[{id:'g',type:'follower',current_amount:9,target_amount:10}]:
   path.endsWith('/campaigns')?[{id:'c',charity_name:'Example',current_amount:{value:1234,decimal_places:2,currency:'USD'}}]:
   path.endsWith('/status')?[{current:{id:'h',level:2,total:100,progress:20,goal:50,expires_at:'2026-11-27T12:02:00Z'}}]:
   [{id:'r',title:'Song',cost:500,is_enabled:true}];
   return Response.json({data});
  });
  const events=await fetchTwitchBroadcasterState(auth,{id:'1',login:'garden'},{fetcher:fetcher as typeof fetch,now:()=>now});
  const signals=events.map(e=>toSocialSignal(e));
  expect(fetcher).toHaveBeenCalledTimes(6);
  expect(signals).toHaveLength(6);
  expect(signals.every(s=>s.source.origin==='replay')).toBe(true);
  expect(signals.find(s=>s.event.type==='poll')?.engagement).toMatchObject({id:'p',expiresAtMs:now+60000,choices:[{id:'a',title:'A',votes:4}]});
  expect(signals.find(s=>s.event.type==='prediction')?.engagement?.phase).toBe('lock');
  expect(signals.find(s=>s.event.type==='hype-train')?.hypeTrain).toMatchObject({id:'h',level:2});
  expect(signals.find(s=>s.event.type==='reward-catalog')?.reward).toMatchObject({id:'r',title:'Song',status:'snapshot',enabled:true});
 });
 it('does not fetch another broadcaster or ungranted families, isolates denied endpoints',async()=>{
  const fetcher=vi.fn(async()=>new Response('',{status:403}));
  expect(await fetchTwitchBroadcasterState(auth,{id:'2',login:'other'},{fetcher:fetcher as typeof fetch})).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await fetchTwitchBroadcasterState({...auth,scopes:['channel:read:goals']},{id:'1',login:'garden'},{fetcher:fetcher as typeof fetch})).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
});
