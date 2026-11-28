import {describe,it,expect} from 'vitest';
import {createKickPollTracker} from '../src/platforms/kick/polls';
import {parseKickPusherFrame,toSocialSignal} from '../src/index';
const ctx={channelName:'garden',channelId:'20'};
const frame=(kind:string,data:unknown)=>parseKickPusherFrame(JSON.stringify({event:'App\\Events\\Poll'+kind+'Event',data:JSON.stringify(data)}));
const update=(remaining=30,votes=0,title='Choose')=>frame('Update',{poll:{title,options:[{id:0,label:'One',votes},{id:1,label:'Two',votes:2}],remaining,result_display_duration:15}});
describe('native Kick poll state',()=>{
 it('tracks a single ID-less poll across votes and handles empty deletion and identical next poll',()=>{
  let now=1000;
  const tracker=createKickPollTracker(ctx,()=>now);
  const a=tracker.receive(update()!)!;
  const first=toSocialSignal(a).engagement!;
  expect(a.id).toBeUndefined();
  expect(first).toMatchObject({phase:'progress',title:'Choose',expiresAtMs:31000,choices:[{id:'0',title:'One',votes:0},{id:'1',title:'Two',votes:2}]});
  now+=2000;
  const b=toSocialSignal(tracker.receive(update(28,3)!)!).engagement!;
  expect(b.id).toBe(first.id);expect(b.choices?.[0]?.votes).toBe(3);
  const deletion=frame('Delete',[]);expect(deletion).not.toBeNull();
  const end=toSocialSignal(tracker.receive(deletion!)!).engagement!;
  expect(end).toMatchObject({id:first.id,phase:'end',status:'removed'});
  expect(end.choices).toBeUndefined();
  expect(tracker.receive(deletion!)).toBeNull();
  expect(toSocialSignal(tracker.receive(update()!)!).engagement?.id).not.toBe(first.id);
 });
 it('rejects malformed updates, preserves unknown counts, resets after expiry',()=>{
  let now=1000;
  const tracker=createKickPollTracker(ctx,()=>now);
  const p=frame('Update',{poll:{title:'Choice',remaining:2,options:[{id:0,label:'A'},{id:1,label:'B',votes:4}]}});
  const a=toSocialSignal(tracker.receive(p!)!).engagement!;
  expect(a.choices?.[0]?.votes).toBeUndefined();
  expect(tracker.receive(frame('Update',{poll:{title:'X',options:[{id:0,label:'A'},{id:0,label:'B'}],remaining:2}})!)).toBeNull();
  now=34000;
  expect(toSocialSignal(tracker.receive(p!)!).engagement?.id).not.toBe(a.id);
 });
});
