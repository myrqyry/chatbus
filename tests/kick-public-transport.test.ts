import {describe,it,expect,vi} from 'vitest';
import {parseKickPublicTransport,loadKickPublicTransport} from '../src/platforms/kick/public-transport';
const now=Date.parse('2026-11-26T12:00:00Z');
const descriptor={schema:1,provider:'pusher',appKey:'publicappkey123',cluster:'us2',observedAt:new Date(now).toISOString()};
describe('published Kick public transport descriptor',()=>{
 it('accepts fresh public metadata only',()=>{
  expect(parseKickPublicTransport(descriptor,now)).toEqual({appKey:'publicappkey123',cluster:'us2'});
  for(const patch of [{schema:2},{provider:'centrifugo'},{cluster:'evil.example'},{appKey:'../evil'},{token:'secret'},{observedAt:new Date(now-3*86400000).toISOString()},{observedAt:new Date(now+3600000).toISOString()}]){
   expect(()=>parseKickPublicTransport({...descriptor,...patch},now)).toThrow();
  }
 });
 it('fetches credential-free static metadata from the known source',async()=>{
  const fetcher=vi.fn(async()=>Response.json(descriptor));
  expect(await loadKickPublicTransport(undefined,fetcher,()=>now)).toEqual({appKey:'publicappkey123',cluster:'us2'});
  expect(fetcher).toHaveBeenCalledWith('https://myrqyry.github.io/chatbus/kick-public-transport.json',expect.objectContaining({credentials:'omit',redirect:'error',cache:'no-store'}));
 });
});
