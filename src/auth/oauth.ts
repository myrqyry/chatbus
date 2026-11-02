/** OAuth protocol primitives. The caller owns redirects, CSRF state validation,
 * storage, access control, and token lifecycle. No account state lives here. */
export type OAuthProvider='youtube'|'twitch';
export type OAuthFetcher=typeof fetch;
export interface OAuthClient {provider:OAuthProvider;clientId:string;clientSecret?:string;redirectUri:string;}
export interface OAuthTokens {accessToken:string;refreshToken?:string;expiresIn?:number;tokenType:string;scopes:string[];}
export interface OAuthBeginOptions extends OAuthClient {scopes:readonly string[];}
export interface OAuthTokenOptions extends OAuthClient {code:string;codeVerifier?:string;fetcher?:OAuthFetcher;signal?:AbortSignal;}
export interface OAuthRefreshOptions extends Omit<OAuthClient,'redirectUri'> {refreshToken:string;fetcher?:OAuthFetcher;signal?:AbortSignal;}

const endpoints={
 youtube:{authorize:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token'},
 twitch:{authorize:'https://id.twitch.tv/oauth2/authorize',token:'https://id.twitch.tv/oauth2/token'},
} as const;
const secureRandom=(size:number):string=>{
 const bytes=new Uint8Array(size);crypto.getRandomValues(bytes);
 return toBase64Url(bytes);
};
const toBase64Url=(bytes:Uint8Array):string=>{
 let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
 return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
};
const required=(value:string,name:string):string=>{
 if(!value?.trim())throw new Error(`OAuth ${name} is required`);
 return value.trim();
};
export async function beginOAuth(options:OAuthBeginOptions):Promise<{url:string;state:string;codeVerifier?:string}>{
 const url=new URL(endpoints[options.provider].authorize);
 const state=secureRandom(24);
 url.searchParams.set('response_type','code');
 url.searchParams.set('client_id',required(options.clientId,'clientId'));
 url.searchParams.set('redirect_uri',required(options.redirectUri,'redirectUri'));
 if(!options.scopes.length)throw new Error('OAuth scopes required');
 url.searchParams.set('scope',options.scopes.join(' '));
 url.searchParams.set('state',state);
 if(options.provider==='youtube'){
  const verifier=secureRandom(32);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));
  url.searchParams.set('code_challenge',toBase64Url(new Uint8Array(digest)));
  url.searchParams.set('code_challenge_method','S256');
  url.searchParams.set('access_type','offline');
  return {url:url.toString(),state,codeVerifier:verifier};
 }
 return {url:url.toString(),state};
}
async function tokenRequest(provider:OAuthProvider,params:URLSearchParams,fetcher:OAuthFetcher,signal?:AbortSignal):Promise<OAuthTokens>{
 const response=await fetcher(endpoints[provider].token,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:params,signal});
 if(!response.ok)throw new Error(`OAuth token request failed (${response.status})`);
 const payload:unknown=await response.json();
 if(!payload||typeof payload!=='object')throw new Error('Invalid OAuth token response');
 const item=payload as Record<string,unknown>;
 if(typeof item.access_token!=='string'||!item.access_token)throw new Error('Invalid OAuth token response');
 return {
  accessToken:item.access_token,
  ...(typeof item.refresh_token==='string'?{refreshToken:item.refresh_token}:{}),
  ...(typeof item.expires_in==='number'&&Number.isFinite(item.expires_in)?{expiresIn:item.expires_in}:{}),
  tokenType:typeof item.token_type==='string'?item.token_type:'Bearer',
  scopes:Array.isArray(item.scope)?item.scope.filter((s):s is string=>typeof s==='string'):
    typeof item.scope==='string'?item.scope.split(' ').filter(Boolean):[],
 };
}
export function exchangeOAuthCode(options:OAuthTokenOptions):Promise<OAuthTokens>{
 const params=new URLSearchParams({grant_type:'authorization_code',client_id:required(options.clientId,'clientId'),
  code:required(options.code,'code'),redirect_uri:required(options.redirectUri,'redirectUri')});
 if(options.clientSecret)params.set('client_secret',options.clientSecret);
 if(options.provider==='twitch'&&!options.clientSecret)throw new Error('Twitch authorization code exchange requires clientSecret');
 if(options.provider==='youtube'&&options.codeVerifier)params.set('code_verifier',options.codeVerifier);
 return tokenRequest(options.provider,params,options.fetcher??fetch,options.signal);
}
export function refreshOAuthToken(options:OAuthRefreshOptions):Promise<OAuthTokens>{
 const params=new URLSearchParams({grant_type:'refresh_token',client_id:required(options.clientId,'clientId'),
  refresh_token:required(options.refreshToken,'refreshToken')});
 if(options.clientSecret)params.set('client_secret',options.clientSecret);
 if(options.provider==='twitch'&&!options.clientSecret)throw new Error('Twitch token refresh requires clientSecret');
 return tokenRequest(options.provider,params,options.fetcher??fetch,options.signal);
}
