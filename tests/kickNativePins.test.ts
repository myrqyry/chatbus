import {describe,it,expect} from 'vitest';
import {normalizeKickEvent,parseKickPusherFrame,toSocialSignal} from '../src/index';
const ctx={channelName:'garden',channelId:'20',now:()=>1000};
const message={id:'message-1',chatroom_id:30,content:'Hello [emote:123:Wave]',created_at:'2026-11-28T00:00:00Z',sender:{id:7,username:'fox'}};
const normalize=(name:string,data:unknown)=>{const p=parseKickPusherFrame(JSON.stringify({event:name,data:JSON.stringify(data)}));return p?normalizeKickEvent(p,ctx):null;};
describe('native Kick pin evidence',()=>{
 it('projects a pin as state, not a duplicate chat row',()=>{
  const event=normalize('App\\Events\\PinnedMessageCreatedEvent',{message,duration:60,pinnedBy:{username:'mod'}})!;
  expect(event.type).toBe('message-pin');expect(event.message).toBeUndefined();
  expect(toSocialSignal(event).pin).toEqual({phase:'set',messageId:'message-1',text:'Hello Wave',username:'fox',pinnedBy:'mod',expiresAtMs:61000});
 });
 it('handles empty removal, explicit removal and deletion, and rejects malformed messages',()=>{
  expect(toSocialSignal(normalize('PinnedMessageDeletedEvent',[])!).pin).toEqual({phase:'remove'});
  expect(toSocialSignal(normalize('App\\Events\\PinnedMessageDeletedEvent',{message:{id:'message-1'}})!).pin).toEqual({phase:'remove',messageId:'message-1'});
  expect(toSocialSignal(normalize('App\\Events\\MessageDeletedEvent',{id:'message-1'})!).pin).toEqual({phase:'remove',messageId:'message-1'});
  expect(normalize('PinnedMessageCreatedEvent',{message:{...message,sender:{}},duration:60})).toBeNull();
  expect(toSocialSignal(normalize('PinnedMessageCreatedEvent',{message})!).pin?.expiresAtMs).toBeUndefined();
 });
});
