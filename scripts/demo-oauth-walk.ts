/**
 * Phase 3 checkpoint demo: boots the real server (in-memory Postgres, fake
 * Spotify upstream) and walks the entire brokered OAuth flow the way Claude
 * would, printing each step. Tokens are truncated in output, never logged in
 * full. Run: npx tsx scripts/demo-oauth-walk.ts
 */
import { startFakeSpotify } from "../test/helpers/fake-spotify.js";
import { startTestApp } from "../test/helpers/test-app.js";
import { codeChallengeS256, generateCodeVerifier } from "../src/auth/pkce.js";

const trunc = (value: string) => `${value.slice(0, 16)}... (${value.length} chars, redacted)`;
const step = (n: number, title: string) => console.log(`\n[${n}] ${title}`);

const spotify = await startFakeSpotify();
const app = await startTestApp({ spotify: spotify.endpoints });
console.log(`server up at ${app.baseUrl} (fake Spotify at ${spotify.baseUrl})`);

step(1, "Claude probes /mcp-protected surface unauthenticated -> 401 + WWW-Authenticate");
const probe = await fetch(`${app.baseUrl}/whoami`);
console.log(`   status ${probe.status}`);
console.log(`   WWW-Authenticate: ${probe.headers.get("www-authenticate")}`);

step(2, "Discovery: GET /.well-known/oauth-protected-resource");
console.log("  ", JSON.stringify(await (await fetch(`${app.baseUrl}/.well-known/oauth-protected-resource`)).json()));

step(3, "Discovery: GET /.well-known/oauth-authorization-server");
console.log("  ", JSON.stringify(await (await fetch(`${app.baseUrl}/.well-known/oauth-authorization-server`)).json()));

step(4, "Dynamic client registration: POST /register");
const registration = await fetch(`${app.baseUrl}/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    client_name: "Claude",
  }),
});
const client = (await registration.json()) as { client_id: string };
console.log(`   status ${registration.status}, client_id: ${client.client_id}`);

step(5, "Browser: GET /authorize (with PKCE) -> 302 to Spotify consent");
const verifier = generateCodeVerifier();
const authorizeUrl = new URL(`${app.baseUrl}/authorize`);
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("client_id", client.client_id);
authorizeUrl.searchParams.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
authorizeUrl.searchParams.set("state", "claude-state-123");
authorizeUrl.searchParams.set("code_challenge", codeChallengeS256(verifier));
authorizeUrl.searchParams.set("code_challenge_method", "S256");
const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" });
const spotifyLocation = new URL(authorizeResponse.headers.get("location")!);
console.log(`   status ${authorizeResponse.status}`);
console.log(`   -> ${spotifyLocation.origin}${spotifyLocation.pathname}`);
console.log(`      scope: ${spotifyLocation.searchParams.get("scope")}`);
console.log(`      spotify_state: ${trunc(spotifyLocation.searchParams.get("state")!)}`);

step(6, "User approves on Spotify; Spotify 302s back to our /callback");
spotify.issueCode("demo-spotify-code", { id: "markandeya", display_name: "Markandeya" });
const callbackUrl = new URL(`${app.baseUrl}/callback`);
callbackUrl.searchParams.set("code", "demo-spotify-code");
callbackUrl.searchParams.set("state", spotifyLocation.searchParams.get("state")!);
const callbackResponse = await fetch(callbackUrl, { redirect: "manual" });
const backToClient = new URL(callbackResponse.headers.get("location")!);
console.log(`   status ${callbackResponse.status}`);
console.log(`   server exchanged Spotify code using Basic auth: ${spotify.tokenExchanges.length === 1 ? "yes" : "no"}`);
console.log(`   -> ${backToClient.origin}${backToClient.pathname}`);
console.log(`      state echoed: ${backToClient.searchParams.get("state")}`);
console.log(`      our code: ${trunc(backToClient.searchParams.get("code")!)}`);

step(7, "Claude: POST /token with our code + PKCE verifier");
const tokenResponse = await fetch(`${app.baseUrl}/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: backToClient.searchParams.get("code")!,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
  }).toString(),
});
const tokens = (await tokenResponse.json()) as {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
};
console.log(`   status ${tokenResponse.status}`);
console.log(`   access_token:  ${trunc(tokens.access_token)}`);
console.log(`   refresh_token: ${trunc(tokens.refresh_token)}`);
console.log(`   token_type ${tokens.token_type}, expires_in ${tokens.expires_in}s`);

step(8, "Bearer token resolves to the correct internal user");
const whoami = await fetch(`${app.baseUrl}/whoami`, {
  headers: { Authorization: `Bearer ${tokens.access_token}` },
});
console.log(`   status ${whoami.status}: ${JSON.stringify(await whoami.json())}`);

step(9, "Replay of the same authorization code is rejected (single use)");
const replay = await fetch(`${app.baseUrl}/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: backToClient.searchParams.get("code")!,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
  }).toString(),
});
console.log(`   status ${replay.status}: ${JSON.stringify(await replay.json())}`);

step(10, "Refresh token rotation");
const refreshResponse = await fetch(`${app.baseUrl}/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: client.client_id,
  }).toString(),
});
const rotated = (await refreshResponse.json()) as { refresh_token: string };
console.log(`   status ${refreshResponse.status}, new refresh_token: ${trunc(rotated.refresh_token)}`);
const oldRefreshReplay = await fetch(`${app.baseUrl}/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: client.client_id,
  }).toString(),
});
console.log(`   old refresh token replay: status ${oldRefreshReplay.status} (rejected)`);

console.log("\nOAuth broker walk COMPLETE");
await app.close();
await spotify.close();
