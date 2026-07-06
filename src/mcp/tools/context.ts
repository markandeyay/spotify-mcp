import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { ok, runTool } from "./helpers.js";
import { getDevices } from "../../spotify/endpoints.js";

/**
 * get_initial_context (Section 8.1): the orientation call. Premium status is
 * reported as "not_yet_determined" until a playback attempt reveals it,
 * because Spotify removed the product field from /me (Decisions Log
 * 2026-07-05). Never guessed, never reported as false without evidence.
 */

export function registerContextTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_initial_context",
    {
      description:
        "Call this first. Returns connection status, the user's Spotify display name, premium status (unknown until a playback attempt reveals it), whether an active device exists right now, and which capability groups are available. Use it to orient before other tools.",
      inputSchema: {},
    },
    async () =>
      runTool(ctx, "get_initial_context", async () => {
        let deviceInfo: Record<string, unknown>;
        try {
          const devices = await getDevices(ctx.client);
          const active = devices.find((d) => d.is_active);
          deviceInfo = {
            device_count: devices.length,
            active_device: active
              ? { name: active.name, type: active.type }
              : null,
          };
        } catch {
          deviceInfo = {
            device_count: null,
            active_device: null,
            device_note: "Device list could not be read; playback tools may still work.",
          };
        }

        const premium = ctx.capabilities.premiumStatus(ctx.user.id);
        const premiumField =
          premium === "unknown"
            ? {
                premium_status: "not_yet_determined",
                premium_note:
                  "Spotify no longer exposes the subscription level to apps. It becomes known after the first playback-control attempt: do not assume free or premium until then.",
              }
            : { premium_status: premium };

        return ok({
          connected: true,
          display_name: ctx.user.displayName,
          spotify_user_id: ctx.user.spotifyUserId,
          ...premiumField,
          ...deviceInfo,
          capabilities: {
            search_and_catalog: true,
            playlists: true,
            playback: "requires Premium and an active device; degrades with guidance",
            library_and_history: true,
            insights:
              "server-computed aggregates; trend quality improves as listening snapshots accumulate",
            unavailable_by_spotify:
              "audio features, audio analysis, recommendations, artist top-tracks, browse/new-releases (removed by Spotify for third-party apps)",
          },
        });
      }),
  );
}
