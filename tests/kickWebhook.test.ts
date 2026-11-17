import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { fetchKickWebhookPublicKey, verifyKickChatWebhook } from '../src/platforms/kick/webhook';

const {publicKey, privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const pem=publicKey.export({type:'spki',format:'pem'}).toString();
const payload={
  message_id:'message-1',content:'Hello [emote:37226:KEKW]',
  created_at:'2026-11-17T20:00:00Z',
  broadcaster:{user_id:42,username:'channel',channel_slug:'channel'},
  sender:{user_id:7,username:'viewer',identity:{username_color:'#abcdef',badges:[{type:'moderator',text:'Moderator'}]}},
  replies_to:{message_id:'parent-1',content:'original',sender:{user_id:8,username:'parent'}},
};
function signed(value:unknown=payload){
  const body=Buffer.from(JSON.stringify(value,null,2));
  const id='01KICKMESSAGE',timestamp='2026-11-17T20:00:01Z';
  const signature=sign('RSA-SHA256',Buffer.concat([Buffer.from(id+'.'+timestamp+'.'),body]),privateKey).toString('base64');
  const headers=new Headers({'Kick-Event-Message-Id':id,'Kick-Event-Message-Timestamp':timestamp,
    'Kick-Event-Signature':signature,'Kick-Event-Subscription-Id':'sub-1',
    'Kick-Event-Type':'chat.message.sent','Kick-Event-Version':'1'});
  return {body,headers,publicKey:pem,subscriptionId:'sub-1',broadcasterUserId:42};
}

describe('official Kick signed chat webhook',()=>{
  it('accepts actual public-key response envelope and validates RSA key',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({data:{public_key:pem},message:''})));
    expect(await fetchKickWebhookPublicKey({fetcher})).toBe(pem);
    expect(fetcher).toHaveBeenCalledWith('https://api.kick.com/public/v1/public-key',expect.objectContaining({signal:expect.any(AbortSignal)}));
    await expect(fetchKickWebhookPublicKey({fetcher:async()=>new Response(JSON.stringify({data:{public_key:'bad'}}))})).rejects.toThrow();
  });
  it('verifies exact signed bytes then emits normalized chat with native emotes and replies',()=>{
    const result=verifyKickChatWebhook(signed());
    expect(result.deliveryId).toBe('01KICKMESSAGE');
    expect(result.event).toMatchObject({type:'message',platform:'kick',origin:'live',channelId:'42',channelName:'channel',
      user:{id:'7',username:'viewer',color:'#abcdef',roles:['moderator']},
      message:{id:'message-1',text:'Hello KEKW',replyToMessageId:'parent-1',
        reply:{parentMessageId:'parent-1',parentUserId:'8',parentUsername:'parent'},
        fragments:[{type:'text',text:'Hello '},{type:'emote',emote:{id:'37226',provider:'kick'}}]}});
  });
  it('rejects changed raw bytes, timestamp or signature',()=>{
    const a=signed();expect(()=>verifyKickChatWebhook({...a,body:Buffer.from(JSON.stringify(payload))})).toThrow(/signature/i);
    a.headers.set('Kick-Event-Message-Timestamp','2026-11-17T20:00:02Z');
    expect(()=>verifyKickChatWebhook(a)).toThrow(/signature/i);
    const b=signed();b.headers.delete('Kick-Event-Signature');expect(()=>verifyKickChatWebhook(b)).toThrow();
  });
  it('rejects wrong subscription, broadcaster, version and malformed signed payload',()=>{
    expect(()=>verifyKickChatWebhook({...signed(),subscriptionId:'sub-2'})).toThrow(/subscription/i);
    expect(()=>verifyKickChatWebhook({...signed(),broadcasterUserId:99})).toThrow(/broadcaster/i);
    const a=signed();a.headers.set('Kick-Event-Version','2');expect(()=>verifyKickChatWebhook(a)).toThrow(/version/i);
    expect(()=>verifyKickChatWebhook(signed({...payload,sender:null}))).toThrow(/payload/i);
    expect(()=>verifyKickChatWebhook(signed({...payload,created_at:'invalid'}))).toThrow(/payload/i);
  });
});
