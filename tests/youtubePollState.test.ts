import {describe,it,expect,vi} from 'vitest';
import {connectYouTubeChat,normalizeYouTubeLiveChatMessage,toSocialSignal,type ChatEvent} from '../src/index';
const poll=(status='active',tally?:string)=>({id:'poll-1',snippet:{type:'pollEvent',publishedAt:'2026-11-28T00:00:00Z',pollDetails:{metadata:{status,questionText:'Choose',options:[{optionText:'A',...(tally===undefined?{}:{tally})},{optionText:'B'}]}}}});
describe('official YouTube poll state',()=>{
 it('maps documented options, optional owner tally and closed status without fabricating votes',()=>{
  const event=normalizeYouTubeLiveChatMessage(poll('active','7'),{now:()=>1000})!;
  expect(event.type).toBe('poll');
  expect(event.timestamp).toBe(1000);
  expect(toSocialSignal(event).engagement).toEqual({kind:'poll',id:'poll-1',phase:'progress',status:'active',title:'Choose',choices:[{id:'0',title:'A',votes:7},{id:'1',title:'B'}]});
  expect(toSocialSignal(normalizeYouTubeLiveChatMessage(poll('closed'),{now:()=>2000})!).engagement?.phase).toBe('end');
  expect(toSocialSignal(normalizeYouTubeLiveChatMessage(poll('unknown'),{})!).engagement).toBeUndefined();
 });
 it('recovers active poll on skipped-history startup and clears it when absent in next successful page',async()=>{
  vi.useFakeTimers();const events:ChatEvent[]=[];
  const fetcher=vi.fn().mockResolvedValueOnce(Response.json({pollingIntervalMillis:100,items:[],activePollItem:poll()})).mockResolvedValueOnce(Response.json({pollingIntervalMillis:100,items:[],activePollItem:poll('active','7')})).mockResolvedValueOnce(Response.json({pollingIntervalMillis:100,items:[],offlineAt:'2026-11-28T00:01:00Z'}));
  vi.stubGlobal('fetch',fetcher);
  try{
   const c=await connectYouTubeChat({liveChatId:'chat',apiKey:'fixture',emitInitialHistory:false,onEvent:e=>events.push(e)});
   try{
    await vi.advanceTimersByTimeAsync(250);
    expect(events.filter(e=>e.type==='poll').map(e=>[e.origin,toSocialSignal(e).engagement?.phase,toSocialSignal(e).engagement?.choices?.[0]?.votes])).toEqual([['replay','progress',undefined],['live','progress',7],['live','end',undefined]]);
   }finally{c.close();}
  }finally{vi.unstubAllGlobals();vi.useRealTimers();}
 });
});
