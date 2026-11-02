# Host-owned OAuth capability

`beginOAuth`, `exchangeOAuthCode` and `refreshOAuthToken` are transport-neutral helpers exported by Chatbus for `youtube` (Google) and `twitch`. Applications such as Overlay Kit own the account lifecycle.

- `beginOAuth({provider,clientId,redirectUri,scopes})` returns `{url,state,codeVerifier?}`. YouTube uses PKCE S256 and requests offline access; Twitch uses its documented confidential-client authorization-code flow, **not an assumed PKCE flow**.
- Host must generate a short-lived, one-use pending authorization record bound to the initiating browser session and provider, containing `state`, redirect URI, and (for YouTube) `codeVerifier`. Verify the callback's `state` with a constant-time comparison, reject callbacks with errors, and consume the pending record before code exchange. Never accept caller-supplied `codeVerifier` without matching its pending session.
- `exchangeOAuthCode` takes the callback code plus the registered client settings and original code verifier; returns normalized tokens. Twitch requires a server-held client secret. Google web application clients may require a registered client secret as well; follow the configured client type.
- `refreshOAuthToken` takes a refresh token and client settings and returns new tokens. Store rotated refresh tokens atomically; when a provider omits a new refresh token, retain the previous one. Refresh failures require reconnect/reauthorization handling in the host. Twitch recommends reacting to 401; expiry alone is not proof of validity.
- Never persist or log credentials, auth codes, token responses, verifiers, or refresh tokens in Chatbus. The host owns encrypted/restricted persistence, per-account authorization, disconnect/revocation, redacted logging and secret lifecycle. Keep secrets out of browser source URLs and OBS data.
- This package does **not** implement callback HTTP routes, a login button, stored accounts, token scheduling, a live authenticated connection test, or a bundled OAuth client registration. A provider developer-console client ID, appropriate redirect registration, scopes and possibly secret are required.

Example host call:

```ts
const pending = await beginOAuth({
  provider: 'youtube', clientId, redirectUri,
  scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
});
// Host persists pending.state / pending.codeVerifier against its browser session.
// Host navigates to pending.url. After validating callback state:
const tokens = await exchangeOAuthCode({provider:'youtube',clientId,clientSecret,
  redirectUri,code,codeVerifier:pending.codeVerifier});
// Host persists tokens and supplies tokens.accessToken to connectYouTubeChat.
```
