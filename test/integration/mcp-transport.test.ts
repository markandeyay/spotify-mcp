import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeSpotify, type FakeSpotify } from "../helpers/fake-spotify.js";
import { startTestApp, type TestApp } from "../helpers/test-app.js";
import { mcpClientFor, obtainBearer } from "../helpers/mcp.js";

/**
 * Phase 4 acceptance, automated: an MCP client (the SDK, standing in for MCP
 * Inspector) authenticates with a broker-issued bearer, lists tools, and
 * calls ping end to end over Streamable HTTP.
 */

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
