import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "./tool-context.js";
import { registerAllTools } from "./tools/index.js";

/**
 * Builds a per-request McpServer bound to the authenticated user's context.
 * Stateless Streamable HTTP: one server per POST keeps horizontal scaling
 * trivial and avoids session bookkeeping.
 */

export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({
    name: "spotify-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "ping",
    {
      description:
        "Health probe. Returns pong plus the authenticated Spotify display name. Use to verify connectivity.",
      inputSchema: {},
      outputSchema: { pong: z.boolean(), display_name: z.string().nullable() },
    },
    async () => {
      const structured = { pong: true, display_name: ctx.user.displayName };
      return {
        content: [{ type: "text", text: JSON.stringify(structured) }],
        structuredContent: structured,
      };
    },
  );

  registerAllTools(server, ctx);
  return server;
}
