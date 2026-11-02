import {afterEach,describe,expect,it,vi} from 'vitest';
import {fetchKickRecentMessages} from '../src/platforms/kick/history';

const channel={channelName:'nickwhite',channelId:'92723',chatroomId:92721};

describe('Kick recent chat history',()=>{
 afterEach(()=>vi.unstubAllGlobals());
 it('normalizes bounded recent messages oldest-first using the resolved channel identity',async()=>{
  const payload={data:{messages:[
   {id:'new',chat_id:92723,user_id:2,content:'newest',created_at:'2026-11-02T22:21:14Z',sender:{id:2,username:'New',identity:{color:'#123456',badges:[]}}},
   {id:'old',chat_id:92723,user_id:1,content:'older',created_at:'2026-11-02T22:21:06Z',sender:{id:1,username:'Old',identity:{color:'#654321',badges:[]}}},
  ]}};
  const fetcher=vi.fn(async()=>new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}}));
  vi.stubGlobal('fetch',fetcher);
  const events=await fetchKickRecentMessages(channel,{limit:20});
  expect(fetcher).toHaveBeenCalledWith('https://kick.com/api/v2/channels/92723/messages',expect.objectContaining({headers:{Accept:'application/json'}}));
  expect(events.map(event=>event.message?.id)).toEqual(['old','new']);
  expect(events[0]).toMatchObject({platform:'kick',channelId:'92723',channelName:'nickwhite',message:{text:'older'}});
 });

 it('drops malformed rows and obeys the newest-N bound before reversing',async()=>{
  const messages=[
   {id:'three',content:'3',created_at:'2026-11-02T22:21:03Z',sender:{id:3,username:'Three'}},
   {id:'two',content:'2',created_at:'2026-11-02T22:21:02Z',sender:{id:2,username:'Two'}},
   {id:'one',content:'1',created_at:'2026-11-02T22:21:01Z',sender:{id:1,username:'One'}},
   {id:7,content:'bad',created_at:'nope',sender:null},
  ];
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({data:{messages}}),{status:200})));
  const events=await fetchKickRecentMessages(channel,{limit:2});
  expect(events.map(event=>event.message?.id)).toEqual(['two','three']);
 });
});
