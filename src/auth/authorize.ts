import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { SPOTIFY_SCOPES, type AuthDeps } from "./deps.js";
import { randomToken } from "./pkce.js";
import { authSessions, mcpClients } from "../db/schema.js";

/**
 * GET /authorize: the meeting point of the two OAuth relationships.
 * Validates the MCP client's request, persists an auth_session carrying the
 * client's PKCE challenge and state, then bounces the user to Spotify.
 */

const authorizeQuerySchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  state: z.string().max(1024).optional(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  scope: z.string().optional(),
});

export function authorizeRouter(deps: AuthDeps): Router {
  const router = Router();

  router.get("/authorize", async (req, res) => {
    const parsed = authorizeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      // Never redirect on validation failure; the redirect target is untrusted.
      res.status(400).send("Invalid authorization request (S256 PKCE is required).");
      return;
    }
    const params = parsed.data;

    const clients = await deps.db
      .select()
      .from(mcpClients)
      .where(eq(mcpClients.clientId, params.client_id))
      .limit(1);
    const client = clients[0];
    if (!client) {
      res.status(400).send("Unknown client_id.");
      return;
    }
    if (!client.redirectUris.includes(params.redirect_uri)) {
      res.status(400).send("redirect_uri is not registered for this client.");
      return;
    }

    const spotifyState = randomToken(32);
    await deps.db.insert(authSessions).values({
      clientId: params.client_id,
      clientRedirectUri: params.redirect_uri,
      clientState: params.state ?? null,
      clientCodeChallenge: params.code_challenge,
      clientCodeChallengeMethod: params.code_challenge_method,
      spotifyState,
      status: "pending",
    });

    const spotifyAuthorize = new URL(deps.spotify.authorizeUrl);
    spotifyAuthorize.searchParams.set("response_type", "code");
    spotifyAuthorize.searchParams.set("client_id", deps.config.SPOTIFY_CLIENT_ID);
    spotifyAuthorize.searchParams.set("redirect_uri", deps.config.SPOTIFY_REDIRECT_URI);
    spotifyAuthorize.searchParams.set("state", spotifyState);
    spotifyAuthorize.searchParams.set("scope", SPOTIFY_SCOPES.join(" "));

    deps.logger.info({ clientId: params.client_id }, "authorize: redirecting user to spotify");
    res.redirect(302, spotifyAuthorize.toString());
  });

  return router;
}
