import {afterEach,describe,expect,it,vi} from 'vitest';
import {beginOAuth,exchangeOAuthCode,refreshOAuthToken,getKickAppAccessToken} from '../src/auth/oauth';

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

describe('official Kick OAuth',()=>{
 it('uses S256 PKCE, state, documented Kick authorize host, and localhost callback',async()=>{
  const input={provider:'kick' as const,clientId:'app-id',redirectUri:'http://localhost:5219/api/oauth/callback',
    scopes:['channel:read','events:subscribe']};
  const begin=await beginOAuth(input);
  const url=new URL(begin.url);
  expect(url.origin).toBe('https://id.kick.com');
  expect(url.pathname).toBe('/oauth/authorize');
  expect(url.searchParams.get('scope')).toBe('channel:read events:subscribe');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(begin.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  expect(url.searchParams.get('redirect_uri')).toBe(input.redirectUri);
  expect(url.searchParams.get('state')).toBe(begin.state);
 });
 it('exchanges Kick code with required secret and PKCE verifier and supports refresh',async()=>{
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({
    access_token:'kick-user',refresh_token:'kick-refresh',expires_in:7200,
    token_type:'Bearer',scope:'channel:read events:subscribe'
  })));
  await expect(exchangeOAuthCode({provider:'kick',clientId:'app',clientSecret:'secret',code:'authorization',
    redirectUri:'http://localhost:5219/api/oauth/callback',fetcher})).rejects.toThrow(/verifier/i);
  const result=await exchangeOAuthCode({provider:'kick',clientId:'app',clientSecret:'secret',code:'authorization',
    redirectUri:'http://localhost:5219/api/oauth/callback',codeVerifier:'secure-verifier',fetcher});
  expect(result.refreshToken).toBe('kick-refresh');
  expect(result.scopes).toEqual(['channel:read','events:subscribe']);
  const [tokenUrl,tokenInit]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
  expect(tokenUrl).toBe('https://id.kick.com/oauth/token');
  const body=new URLSearchParams(String(tokenInit.body));
  expect(body.get('code_verifier')).toBe('secure-verifier');
  expect(body.get('client_secret')).toBe('secret');
  await refreshOAuthToken({provider:'kick',clientId:'app',clientSecret:'secret',
    refreshToken:'kick-refresh',fetcher});
  const refresh=new URLSearchParams(String((fetcher.mock.calls[1] as unknown as [string,RequestInit])[1].body));
  expect(refresh.get('grant_type')).toBe('refresh_token');
  expect(refresh.get('refresh_token')).toBe('kick-refresh');
 });
});

describe('Kick app credentials token flow',()=>{
 it('obtains an app token using Kick client credentials without a user or redirect',async()=>{
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({
    access_token:'app-only',expires_in:7200,token_type:'Bearer'
  })));
  const token=await getKickAppAccessToken({clientId:'client',clientSecret:'secret',fetcher});
  expect(token.accessToken).toBe('app-only');
  const [url,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toBe('https://id.kick.com/oauth/token');
  const body=new URLSearchParams(String(init.body));
  expect(body.get('grant_type')).toBe('client_credentials');
  expect(body.get('client_id')).toBe('client');
  expect(body.get('client_secret')).toBe('secret');
  expect(body.has('redirect_uri')).toBe(false);
 });
});
