import type { Request, RequestHandler, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./server.js";
import { buildToolContext, type ToolContextDeps } from "./tool-context.js";

/**
 * Streamable HTTP wiring (MCP spec 2025+). Stateless mode: each POST gets a
 * fresh transport and server bound to the resolved user. GET (SSE resumption)
 * and DELETE (session teardown) are not applicable without sessions and
 * return JSON-RPC errors per the SDK's stateless pattern.
 */

export function mcpPostHandler(deps: ToolContextDeps): RequestHandler {
  return async (req: Request, res: Response) => {
    const user = req.user;
    if (!user) {
      // requireAuth runs first; this is a defensive guard, not a real path.
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    const ctx = buildToolContext(deps, user);
    const server = buildMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      deps.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "mcp request handling failed",
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };
}

export function mcpMethodNotAllowed(): RequestHandler {
  return (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed in stateless mode" },
      id: null,
    });
  };
}
