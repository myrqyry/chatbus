import {describe,expect,it} from 'vitest';
import {createRepeatDetector} from '../src/index';
const msg=(id:string,text:string,sender='a',scope='room',now=0,variant='')=>({id,text,sender,scope,now,variant});
describe('repeat detector',()=>{
 it('counts distinct events, not transport redelivery, and isolates sender and room',()=>{
  const d=createRepeatDetector();
  expect(d.observe(msg('1','Kappa'))?.count).toBe(1);
  expect(d.observe(msg('1','Kappa'))).toBeUndefined();
  expect(d.observe(msg('2','Kappa'))).toMatchObject({firstId:'1',count:2,uniqueSenderCount:1});
  expect(d.observe(msg('3','Kappa','b'))?.count).toBe(1);
  expect(d.observe(msg('4','Kappa','a','other'))?.count).toBe(1);
  expect(d.observe(msg('5','kappa'))?.count).toBe(1);
 });
 it('supports normalized and collective matches without merging distinct variants',()=>{
  const d=createRepeatDetector({match:'normalized',senderScope:'channel'});
  d.observe(msg('1','  HELLO  world','a'));
  expect(d.observe(msg('2','hello world','b'))).toMatchObject({count:2,uniqueSenderCount:2});
  expect(d.observe(msg('3','hello world','b','room',0,'emote:1'))?.count).toBe(1);
 });
 it('expires inactive groups and bounds cache, including dedupe entries',()=>{
  const d=createRepeatDetector({windowMs:10,maxEntries:2});
  d.observe(msg('1','a'));
  expect(d.observe(msg('2','a','a','room',11))?.count).toBe(1);
  d.observe(msg('3','b','a','room',11));
  d.observe(msg('4','c','a','room',11));
  expect(d.observe(msg('5','a','a','room',11))?.count).toBe(1);
  d.clear();
  expect(d.observe(msg('5','a','a','room',11))?.count).toBe(1);
 });
 it('supports conservative near matches for long plain text, not short emotes',()=>{
  const d=createRepeatDetector({match:'near'});
  d.observe(msg('1','this is a very long message'));
  expect(d.observe(msg('2','this is a very long mesage'))?.count).toBe(2);
  d.observe(msg('3','Kappa'));
  expect(d.observe(msg('4','Kappaa'))?.count).toBe(1);
 });
 it('starts a new group if its representative is no longer active',()=>{
  const d=createRepeatDetector();
  d.observe(msg('1','hi'));
  expect(d.observe(msg('2','hi'),()=>false)).toMatchObject({firstId:'2',count:1});
 });
 it('can forget a group when its visual representative is removed',()=>{
  const d=createRepeatDetector();
  d.observe(msg('1','hi'));
  d.forget('room','1');
  expect(d.observe(msg('2','hi'))?.count).toBe(1);
 });
});
