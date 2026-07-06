import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";

/**
 * Central tool registry. Each module registers one Section 8 tool group;
 * modules are added phase by phase.
 */

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  void server;
  void ctx;
}
