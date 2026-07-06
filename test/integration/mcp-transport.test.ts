import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startFakeSpotify, type FakeSpotify } from "../helpers/fake-spotify.js";
import { startTestApp, type TestApp } from "../helpers/test-app.js";
import { codeChallengeS256, generateCodeVerifier } from "../../src/auth/pkce.js";

/**
 * Phase 4 acceptance, automated: an MCP client (the SDK, standing in for MCP
 * Inspector) authenticates with a broker-issued bearer, lists tools, and
 * calls ping end to end over Streamable HTTP.
 */

const CLIENT_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

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

describe("MCP transport", () => {
  let spotify: FakeSpotify;
  let app: TestApp;
  let bearer: string;

  beforeAll(async () => {
    spotify = await startFakeSpotify();
    app = await startTestApp({ spotify: spotify.endpoints });
    bearer = await obtainBearer(app, spotify, { id: "mcp-user", display_name: "MCP User" });
  });

  afterAll(async () => {
    await app.close();
    await spotify.close();
  });

  it("rejects an unauthenticated POST /mcp with 401 and WWW-Authenticate", async () => {
    const response = await fetch(`${app.baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("connects, lists tools, and calls ping with a valid bearer", async () => {
    const { client, transport } = mcpClientFor(app, bearer);
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("ping");

      const result = await client.callTool({ name: "ping", arguments: {} });
      expect(result.isError ?? false).toBe(false);
      expect(result.structuredContent).toEqual({
        pong: true,
        display_name: "MCP User",
      });
    } finally {
      await client.close();
    }
  });

  it("returns 405 for GET /mcp in stateless mode", async () => {
    const response = await fetch(`${app.baseUrl}/mcp`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    expect(response.status).toBe(405);
  });
});
