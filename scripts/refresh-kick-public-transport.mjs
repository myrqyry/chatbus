// Publish only the provider's public Pusher application identifier and cluster.
// Never acquire, store or serve a guest token, credentials or chat messages.
import {writeFileSync} from 'node:fs';
import {parseKickPublicTransport} from '../src/platforms/kick/public-transport.ts';
const response=await fetch('https://web.kick.com/api/v1/realtime/connection',{
 method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),
 headers:{Accept:'application/json','Content-Type':'application/json'},
 body:JSON.stringify({client:{id:crypto.randomUUID(),type:'web'},capabilities:{accepted_providers:[{provider:'pusher'}]}}),
});
if(!response.ok)throw Error('Kick public negotiation HTTP '+response.status);
const raw=await response.json();
const publicApp=raw?.data?.connections?.find(x=>x.provider==='pusher');
const descriptor={schema:1,provider:'pusher',appKey:publicApp?.credentials?.app_key,cluster:publicApp?.credentials?.cluster,observedAt:new Date().toISOString()};
parseKickPublicTransport(descriptor);
writeFileSync('dist-browser/kick-public-transport.json',JSON.stringify(descriptor)+'\n');
console.log('Refreshed public Kick Pusher descriptor (no credentials or tokens)');
