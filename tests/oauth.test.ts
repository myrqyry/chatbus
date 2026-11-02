import {afterEach,describe,expect,it,vi} from 'vitest';
import {beginOAuth,exchangeOAuthCode,refreshOAuthToken} from '../src/auth/oauth';

afterEach(()=>vi.unstubAllGlobals());
describe('host-owned OAuth operations',()=>{
 it('generates Google PKCE and state without persisting credentials',async()=>{
  const request=await beginOAuth({provider:'youtube',clientId:'app-id',redirectUri:'http://localhost:5219/oauth/callback',scopes:['https://www.googleapis.com/auth/youtube.readonly']});
  const url=new URL(request.url);
  expect(url.origin).toBe('https://accounts.google.com');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(request.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  expect(request.state).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  expect(url.searchParams.get('state')).toBe(request.state);
  expect(url.searchParams.get('access_type')).toBe('offline');
 });
 it('exchanges Google code and preserves refresh token for the host',async()=>{
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({access_token:'a',refresh_token:'r',expires_in:3600,token_type:'Bearer',scope:'scope'}),{status:200}));
  const tokens=await exchangeOAuthCode({provider:'youtube',clientId:'client',clientSecret:'secret',redirectUri:'http://localhost/callback',code:'code',codeVerifier:'verifier',fetcher});
  expect(tokens).toMatchObject({accessToken:'a',refreshToken:'r',expiresIn:3600});
  const [endpoint,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
  expect(endpoint).toBe('https://oauth2.googleapis.com/token');
  expect(String(init.body)).toContain('code_verifier=verifier');
 });
 it('uses Twitch confidential-client code grant and refresh, without pretending Twitch PKCE is supported',async()=>{
  const request=await beginOAuth({provider:'twitch',clientId:'client',redirectUri:'http://localhost/callback',scopes:['user:read:chat']});
  const url=new URL(request.url);
  expect(url.host).toBe('id.twitch.tv');
  expect(url.searchParams.has('code_challenge')).toBe(false);
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({access_token:'new',expires_in:300,refresh_token:'rotated',token_type:'bearer'})));
  const tokens=await refreshOAuthToken({provider:'twitch',clientId:'client',clientSecret:'secret',refreshToken:'old',fetcher});
  expect(tokens.refreshToken).toBe('rotated');
  expect(String((fetcher.mock.calls[0] as unknown as [string,RequestInit])[1].body)).toContain('refresh_token=old');
 });
 it('rejects invalid and unsuccessful token responses without leaking raw credentials',async()=>{
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({error:'invalid_grant',error_description:'secret token foo'}),{status:400}));
  await expect(refreshOAuthToken({provider:'youtube',clientId:'client',refreshToken:'sensitive',fetcher})).rejects.toThrow('OAuth token request failed (400)');
 });
});
