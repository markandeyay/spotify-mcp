import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FakeSpotify } from "./fake-spotify.js";
import type { TestApp } from "./test-app.js";
import { codeChallengeS256, generateCodeVerifier } from "../../src/auth/pkce.js";

export const CLIENT_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

/** Scripted Claude: register, authorize, consent, redeem, return the bearer. */
export async function obtainBearer(
  app: TestApp,
  spotify: FakeSpotify,
  spotifyUser: { id: string; display_name?: string },
): Promise<string> {
  const registration = await fetch(`${app.baseUrl}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CLIENT_REDIRECT] }),
  });
  const { client_id: clientId } = (await registration.json()) as { client_id: string };
  const verifier = generateCodeVerifier();
  const authorizeUrl = new URL(`${app.baseUrl}/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", CLIENT_REDIRECT);
  authorizeUrl.searchParams.set("code_challenge", codeChallengeS256(verifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" });
  const spotifyState = new URL(authorizeResponse.headers.get("location")!).searchParams.get(
    "state",
  )!;
  const code = `spotify-code-${spotifyUser.id}-${Math.random().toString(36).slice(2)}`;
  spotify.issueCode(code, spotifyUser);
  const callbackResponse = await fetch(
    `${app.baseUrl}/callback?code=${code}&state=${spotifyState}`,
    { redirect: "manual" },
  );
  const ourCode = new URL(callbackResponse.headers.get("location")!).searchParams.get("code")!;
  const tokenResponse = await fetch(`${app.baseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: ourCode,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT,
    }).toString(),
  });
  const tokens = (await tokenResponse.json()) as { access_token: string };
  return tokens.access_token;
}

export function mcpClientFor(app: TestApp, bearer: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${app.baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: "test-client", version: "0.0.1" });
  return { client, transport };
}

/** Connects a fresh MCP client, runs fn, always closes. */
export async function withMcpClient<T>(
  app: TestApp,
  bearer: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const { client, transport } = mcpClientFor(app, bearer);
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
