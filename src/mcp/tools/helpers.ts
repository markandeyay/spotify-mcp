import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../tool-context.js";
import {
  AppError,
  EndpointUnavailableError,
  NoActiveDeviceError,
  PremiumRequiredError,
  RateLimitedError,
  SpotifyAuthError,
  SpotifyResponseShapeError,
} from "../../util/errors.js";

/**
 * Shared result and error mapping (Section 11). Raw Spotify error bodies
 * never reach the model; every failure becomes a short, actionable sentence.
 */

export function ok(structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

export function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function runTool(
  ctx: ToolContext,
  toolName: string,
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    return mapError(ctx, toolName, error);
  }
}

function mapError(ctx: ToolContext, toolName: string, error: unknown): CallToolResult {
  if (error instanceof NoActiveDeviceError || error instanceof PremiumRequiredError) {
    return toolError(error.message);
  }
  if (error instanceof SpotifyAuthError) {
    return toolError(
      "Spotify authorization has lapsed. Ask the user to reconnect the Spotify connector.",
    );
  }
  if (error instanceof RateLimitedError) {
    return toolError("Spotify is rate limiting right now. Wait a moment and try again.");
  }
  if (error instanceof EndpointUnavailableError) {
    return toolError(
      "Spotify no longer offers this capability for third-party apps, so this feature is unavailable.",
    );
  }
  if (error instanceof SpotifyResponseShapeError) {
    ctx.logger.warn({ tool: toolName, detail: error.message }, "unexpected spotify shape");
    return toolError("Spotify returned data in an unexpected shape; this tool may be degraded.");
  }
  if (error instanceof AppError) {
    ctx.logger.warn({ tool: toolName, code: error.code }, "tool failed");
    return toolError(`The request to Spotify failed (${error.code}). Try again shortly.`);
  }
  ctx.logger.error(
    { tool: toolName, err: error instanceof Error ? error.message : String(error) },
    "tool crashed",
  );
  return toolError("Something went wrong on the server; try again.");
}

/** Compact track line for list outputs: keeps context windows small. */
export function compactTrack(track: {
  id: string;
  name: string;
  uri?: string | undefined;
  artists?: { name: string }[] | undefined;
  duration_ms?: number | undefined;
  album?: { name?: string; release_date?: string | undefined } | undefined;
}): Record<string, unknown> {
  return {
    id: track.id,
    name: track.name,
    ...(track.uri ? { uri: track.uri } : {}),
    artist: track.artists?.map((a) => a.name).join(", ") ?? "unknown",
    ...(track.duration_ms !== undefined ? { duration_ms: track.duration_ms } : {}),
    ...(track.album?.name ? { album: track.album.name } : {}),
    ...(track.album?.release_date ? { released: track.album.release_date } : {}),
  };
}
