import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../tool-context.js";
import { compactTrack, ok, runTool, toolError } from "./helpers.js";
import {
  controlPlayback,
  getDevices,
  getPlaybackState,
  queueTrack,
  transferPlayback,
} from "../../spotify/endpoints.js";
import {
  isNoActiveDeviceError,
  isPremiumRequiredError,
} from "../../spotify/capabilities.js";

/**
 * Playback tools (Section 8.4). Every control call funnels through
 * attemptPlaybackControl so premium status converges from real outcomes and
 * no-device / non-premium turn into friendly guidance, never raw 403/404s.
 */

const NO_DEVICE_MESSAGE =
  "No active Spotify device. Ask the user to open Spotify on any device (phone, desktop, web player) and play or resume anything once; then this will work.";
const NOT_PREMIUM_MESSAGE =
  "This Spotify account does not have Premium, which Spotify requires for remote playback control. Everything read-only (search, playlists, library, insights) still works.";

async function attemptPlaybackControl(
  ctx: ToolContext,
  action: () => Promise<void>,
  successBody: Record<string, unknown>,
): Promise<CallToolResult> {
  if (ctx.capabilities.premiumStatus(ctx.user.id) === "free") {
    return toolError(NOT_PREMIUM_MESSAGE);
  }
  try {
    await action();
    ctx.capabilities.recordPlaybackOutcome(ctx.user.id, "ok");
    return ok({ ...successBody, premium_status: "premium" });
  } catch (error) {
    if (isPremiumRequiredError(error)) {
      ctx.capabilities.recordPlaybackOutcome(ctx.user.id, "premium_required");
      return toolError(NOT_PREMIUM_MESSAGE);
    }
    if (isNoActiveDeviceError(error)) {
      return toolError(NO_DEVICE_MESSAGE);
    }
    throw error;
  }
}

export function registerPlaybackTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_playback_state",
    {
      description:
        "What is playing right now: track, device, shuffle/repeat, progress. Works without Premium. Returns nothing_playing when no session is active.",
      inputSchema: {},
    },
    async () =>
      runTool(ctx, "get_playback_state", async () => {
        const state = await getPlaybackState(ctx.client);
        if (!state) {
          return ok({
            nothing_playing: true,
            note: "No active playback session. The user may not have Spotify open anywhere.",
          });
        }
        return ok({
          is_playing: state.is_playing,
          ...(state.item ? { track: compactTrack(state.item) } : {}),
          ...(state.progress_ms != null ? { progress_ms: state.progress_ms } : {}),
          ...(state.device
            ? { device: { name: state.device.name, type: state.device.type, volume_percent: state.device.volume_percent ?? null } }
            : {}),
          ...(state.shuffle_state !== undefined ? { shuffle: state.shuffle_state } : {}),
          ...(state.repeat_state !== undefined ? { repeat: state.repeat_state } : {}),
        });
      }),
  );

  server.registerTool(
    "list_devices",
    {
      description: "List the user's available Spotify devices and which one is active.",
      inputSchema: {},
    },
    async () =>
      runTool(ctx, "list_devices", async () => {
        const devices = await getDevices(ctx.client);
        return ok({
          devices: devices.map((d) => ({
            id: d.id,
            name: d.name,
            type: d.type,
            is_active: d.is_active,
            volume_percent: d.volume_percent ?? null,
          })),
          ...(devices.length === 0
            ? { note: "No devices found. Spotify must be open somewhere to appear here." }
            : {}),
        });
      }),
  );

  server.registerTool(
    "control_playback",
    {
      description:
        "Control playback: play (optionally specific track URIs or a context like a playlist), pause, next, previous, seek (position_ms), or volume (volume_percent). Requires Premium and an active device; failures return guidance instead of errors.",
      inputSchema: {
        action: z.enum(["play", "pause", "next", "previous", "seek", "volume"]),
        track_uris: z.array(z.string()).optional().describe("For play: specific tracks to play"),
        context_uri: z.string().optional().describe("For play: album/playlist URI to play from"),
        position_ms: z.number().int().min(0).optional().describe("For seek"),
        volume_percent: z.number().int().min(0).max(100).optional().describe("For volume"),
      },
    },
    async ({ action, track_uris, context_uri, position_ms, volume_percent }) =>
      runTool(ctx, "control_playback", async () => {
        if (action === "seek" && position_ms === undefined) {
          return toolError("seek requires position_ms.");
        }
        if (action === "volume" && volume_percent === undefined) {
          return toolError("volume requires volume_percent.");
        }
        const command =
          action === "play"
            ? { action: "play" as const, ...(track_uris ? { uris: track_uris } : {}), ...(context_uri ? { contextUri: context_uri } : {}) }
            : action === "seek"
              ? { action: "seek" as const, positionMs: position_ms! }
              : action === "volume"
                ? { action: "volume" as const, volumePercent: volume_percent! }
                : { action };
        return attemptPlaybackControl(ctx, () => controlPlayback(ctx.client, command), {
          action,
          done: true,
        });
      }),
  );

  server.registerTool(
    "queue_tracks",
    {
      description:
        "Add tracks (spotify:track: URIs) to the playback queue in order. Requires Premium and an active device.",
      inputSchema: {
        track_uris: z.array(z.string().startsWith("spotify:")).min(1).max(20),
      },
    },
    async ({ track_uris }) =>
      runTool(ctx, "queue_tracks", async () =>
        attemptPlaybackControl(
          ctx,
          async () => {
            for (const uri of track_uris) {
              await queueTrack(ctx.client, uri);
            }
          },
          { queued: track_uris.length },
        ),
      ),
  );

  server.registerTool(
    "transfer_playback",
    {
      description:
        "Move playback to another device by device id (from list_devices). Set play true to start playing there immediately.",
      inputSchema: {
        device_id: z.string().min(1),
        play: z.boolean().default(true),
      },
    },
    async ({ device_id, play }) =>
      runTool(ctx, "transfer_playback", async () =>
        attemptPlaybackControl(
          ctx,
          () => transferPlayback(ctx.client, device_id, play),
          { transferred_to: device_id, playing: play },
        ),
      ),
  );
}
