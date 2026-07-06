import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { registerContextTools } from "./context.js";
import { registerSearchTools } from "./search.js";
import { registerInfoTools } from "./info.js";
import { registerPlaylistTools } from "./playlists.js";
import { registerPlaybackTools } from "./playback.js";
import { registerLibraryTools } from "./library.js";
import { registerInsightTools } from "./insights.js";

/** Central tool registry; one module per Section 8 tool group. */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerContextTools(server, ctx);
  registerSearchTools(server, ctx);
  registerInfoTools(server, ctx);
  registerPlaylistTools(server, ctx);
  registerPlaybackTools(server, ctx);
  registerLibraryTools(server, ctx);
  registerInsightTools(server, ctx);
}
