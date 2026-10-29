import { describe,expect,it } from 'vitest';
import {
  createKickBadgeCatalog, parseKickSubscriberBadges, parseKickUserBadgesV2, normalizeKickEvent,
} from '../src/index';

const url=(id:number)=>`https://files.kick.com/channel_subscriber_badges/${id}/conversion/original-fullsize.png`;
const response={subscriber_badges:[
  {id:1,months:1,badge_image:{src:url(1)}},
  {id:2,months:3,badge_image:{src:url(2)}},
  {id:3,months:12,badge_image:{src:url(3)}},
]};
const sub=(version?:string)=>({provider:'kick' as const,id:'subscriber',version});

describe('Kick badge normalization and discovery',()=>{
  it('only admits real milestone art on Kick image hosts',()=>{
    expect(parseKickSubscriberBadges({subscriber_badges:[
      ...response.subscriber_badges,
      {months:24,badge_image:{src:'https://evil.example/steal.png'}},
      {months:36,badge_image:{src:'https://files.kick.com.evil.org/file.png'}},
      {months:-1,badge_image:{src:url(5)}},
      {months:6,badge_image:{src:'http://files.kick.com/channel_subscriber_badges/4/conversion/original-fullsize.png'}},
      {months:0,badge_image:{src:url(6)}},
    ]})).toEqual([{months:1,url:url(1)},{months:3,url:url(2)},{months:12,url:url(3)}]);
  });
  it('resolves highest earned milestone and ignores unknown roles, invalid counts, and other providers',async()=>{
    const catalog=createKickBadgeCatalog(async()=>response);
    await catalog.loadChannel('teststream',()=>{});
    expect(catalog.health()).toBe('ready');
    expect(catalog.resolve([sub('3'),sub('6'),sub('15')]).map(b=>b.images[0]?.url)).toEqual([url(2),url(2),url(3)]);
    expect(catalog.resolve([sub('0'),sub(),sub('x'),{provider:'kick',id:'moderator'},
      {provider:'twitch',id:'subscriber',version:'3'}])).toEqual([]);
    expect(catalog.resolve([sub('3')])[0]).toMatchObject({
      id:'subscriber',provider:'kick',scope:'channel',version:'3',name:'Subscriber (3 months)',
    });
  });
  it('coalesces simultaneous loads, ignores stale completions, and retains current-channel results',async()=>{
    const completions=new Map<string,(value:unknown)=>void>();
    const calls:string[]=[];
    const catalog=createKickBadgeCatalog(url=>{
      calls.push(url);
      return new Promise(resolve=>{completions.set(url,resolve);});
    });
    const callbacks:string[]=[];
    const old=catalog.loadChannel('old',()=>callbacks.push('old'));
    const duplicate=catalog.loadChannel('old',()=>callbacks.push('duplicate'));
    expect(calls).toHaveLength(1);
    const next=catalog.loadChannel('new',()=>callbacks.push('new'));
    expect(calls).toHaveLength(2);
    completions.get(calls[1]!)!(response);
    await next;
    completions.get(calls[0]!)!({subscriber_badges:[{months:1,badge_image:{src:url(99)}}]});
    await Promise.all([old,duplicate]);
    expect(catalog.resolve([sub('3')])[0]?.images[0]?.url).toBe(url(2));
    expect(callbacks).toEqual(['new']);
  });
  it('cooldowns failed loads rather than hammering the endpoint',async()=>{
    let count=0;
    const catalog=createKickBadgeCatalog(async()=>{count++;throw new Error('blocked');});
    await catalog.loadChannel('some_channel',()=>{});
    expect(catalog.health()).toBe('degraded');
    await catalog.loadChannel('some_channel',()=>{});
    expect(count).toBe(1);
  });
});


describe('Kick native image-backed badges (badges_v2)',()=>{
  const cdn='https://ext.cdn.kick.com/chat/badges/';
  const flyby=cdn+'Flyby_019f591a-e1bb-7a1a-be0a-97d8d1ae1a91.png';
  const goat=cdn+'GOAT_019f591b-30ae-7285-8377-293e708a5e30.png';
  it('preserves displayed global and level badges in source order, without external lookup',()=>{
    const raw=[
      {name:'Flyby',badge_type:'global',image_url:flyby,selected:true,sort_order:4},
      {name:'GOAT',badge_type:'global',image_url:goat,selected:true,sort_order:2},
      {name:'level',badge_type:'global',image_url:cdn+'46_1629c3f5-cd67-4189-a508-be557265254d.png',metadata:{level:46},selected:false,sort_order:1},
      {name:'Flyby',badge_type:'global',image_url:flyby,selected:true,sort_order:4},
    ];
    const badges=parseKickUserBadgesV2(raw);
    expect(badges).toMatchObject([
      {id:'level',name:'Level 46',provider:'kick'},
      {id:'GOAT',provider:'kick',scope:'global',images:[{url:goat}]},
      {id:'Flyby',provider:'kick',scope:'global',images:[{url:flyby}]},
    ]);
    expect(badges).toHaveLength(3);
  });
  it('rejects unselected, malformed and non-Kick hosted images',()=>{
    expect(parseKickUserBadgesV2([
      {name:'bad',badge_type:'global',image_url:'https://ext.cdn.kick.com.evil.invalid/chat/badges/a.png',selected:true},
      {name:'bad',badge_type:'global',image_url:'https://other.example/chat/badges/a.png',selected:true},
      {name:'bad',badge_type:'global',image_url:'javascript:alert(1)',selected:true},
      {name:'bad',badge_type:'global',image_url:cdn+'../payload.png',selected:true},
      {name:'bad',badge_type:'global',image_url:cdn+'name.svg',selected:true},
      {name:'bad',badge_type:'global',image_url:cdn+'Badge_123.png',selected:false},
      {name:'bad',badge_type:'global',image_url:cdn+'Badge_123.png'},
      {name:'bad',badge_type:'unknown',image_url:cdn+'Badge_123.png',selected:true},
    ])).toEqual([]);
  });
  it('normalizes actual Kick sender metadata into badges while retaining subscriber refs',()=>{
    const event=normalizeKickEvent({type:'ChatMessage',data:{
      id:'kick-id-1',chatroom_id:92721,content:'hello',created_at:'2026-10-28T16:00:00Z',
      sender:{id:19,username:'viewer',identity:{
        badges:[{type:'subscriber',text:'Subscriber',count:2}],
        badges_v2:[
          {name:'Flyby',badge_type:'global',image_url:flyby,selected:true,sort_order:4},
          {name:'level',badge_type:'global',image_url:cdn+'50_b83d144a-3f6f-4bbe-a50c-80aebc21420b.png',metadata:{level:50},selected:false,sort_order:1},
        ],
      }},
    }},{channelName:'nickwhite'});
    expect(event?.message?.user.badgeRefs).toMatchObject([{id:'subscriber',provider:'kick',version:'2'}]);
    expect(event?.message?.user.badges).toMatchObject([{id:'level',name:'Level 50',provider:'kick'}, {id:'Flyby',provider:'kick',images:[{url:flyby}]}]);
    expect(event?.message?.user.badges).toHaveLength(2);
  });
});
