import {describe,it,expect} from 'vitest';
import {parseRelayCommand,RELAY_PROTOCOL_VERSION} from '../src/relay/protocol';

describe('Chatbus relay protocol',()=>{
  it('accepts one bounded provider target connection request',()=>{
    expect(parseRelayCommand(JSON.stringify({type:'connect',platform:'kick',target:' NickWhite '}))).toEqual({
      type:'connect',platform:'kick',target:'NickWhite',protocol:RELAY_PROTOCOL_VERSION,
    });
  });

  it('rejects unsupported platforms, blank/oversized targets, and malformed JSON',()=>{
    for(const input of [
      '{',
      JSON.stringify({type:'connect',platform:'custom',target:'x'}),
      JSON.stringify({type:'connect',platform:'kick',target:'   '}),
      JSON.stringify({type:'connect',platform:'kick',target:'x'.repeat(501)}),
      JSON.stringify({type:'wat'}),
    ]) expect(()=>parseRelayCommand(input)).toThrow();
  });
});
