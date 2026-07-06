import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { AUTH_SESSION_TTL_MS, type AuthDeps } from "./deps.js";
import { randomToken } from "./pkce.js";
import { authSessions } from "../db/schema.js";
import { saveSpotifyTokens, upsertUser } from "../db/token-store.js";

/**
 * GET /callback: Spotify sends the user back here. Exchange the Spotify code
 * for tokens (server-side, using our client secret), identify the user via
 * /me, store encrypted tokens, then hand the user back to the MCP client with
 * our own single-use authorization code. Spotify tokens never leave this
 * server.
 */

const spotifyTokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

const spotifyMeSchema = z.object({
  id: z.string(),
  display_name: z.string().nullable().optional(),
});

export function callbackRouter(deps: AuthDeps): Router {
  const router = Router();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());

  router.get("/callback", async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const upstreamError = typeof req.query.error === "string" ? req.query.error : undefined;

    if (!state) {
      res.status(400).send("Missing state.");
      return;
    }
    const sessions = await deps.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.spotifyState, state))
      .limit(1);
    const session = sessions[0];
    if (!session || session.status !== "pending") {
      res.status(400).send("Unknown or already used authorization session.");
      return;
    }
    if (now().getTime() - session.createdAt.getTime() > AUTH_SESSION_TTL_MS) {
      res.status(400).send("Authorization session expired; please start over.");
      return;
    }

    const clientRedirect = new URL(session.clientRedirectUri);
    if (session.clientState !== null) {
      clientRedirect.searchParams.set("state", session.clientState);
    }

    if (upstreamError || !code) {
      // User declined on Spotify's consent screen (or Spotify errored).
      await deps.db
        .update(authSessions)
        .set({ status: "consumed" })
        .where(eq(authSessions.id, session.id));
      clientRedirect.searchParams.set("error", "access_denied");
      res.redirect(302, clientRedirect.toString());
      return;
    }

    // Leg 2: exchange the Spotify code using our confidential credentials.
    const basic = Buffer.from(
      `${deps.config.SPOTIFY_CLIENT_ID}:${deps.config.SPOTIFY_CLIENT_SECRET}`,
    ).toString("base64");
    const tokenResponse = await fetchImpl(deps.spotify.tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: deps.config.SPOTIFY_REDIRECT_URI,
      }).toString(),
    });
    if (!tokenResponse.ok) {
      deps.logger.error(
        { status: tokenResponse.status },
        "spotify token exchange failed",
      );
      res.status(502).send("Spotify token exchange failed; please try connecting again.");
      return;
    }
    const tokens = spotifyTokenResponseSchema.safeParse(await tokenResponse.json());
    if (!tokens.success) {
      res.status(502).send("Unexpected token response from Spotify.");
      return;
    }

    const meResponse = await fetchImpl(`${deps.spotify.apiBaseUrl}/me`, {
      headers: { Authorization: `Bearer ${tokens.data.access_token}` },
    });
    if (!meResponse.ok) {
      res.status(502).send("Could not identify the Spotify user.");
      return;
    }
    const me = spotifyMeSchema.safeParse(await meResponse.json());
    if (!me.success) {
      res.status(502).send("Unexpected /me response from Spotify.");
      return;
    }

    const user = await upsertUser(deps.db, me.data.id, me.data.display_name ?? null);
    await saveSpotifyTokens(deps.db, deps.encryptionKey, user.id, {
      accessToken: tokens.data.access_token,
      refreshToken: tokens.data.refresh_token,
      accessExpiresAt: new Date(now().getTime() + tokens.data.expires_in * 1000),
      scope: tokens.data.scope ?? "",
    });

    const ourAuthCode = randomToken(32);
    await deps.db
      .update(authSessions)
      .set({ userId: user.id, ourAuthCode, status: "code_issued" })
      .where(eq(authSessions.id, session.id));

    deps.logger.info({ userId: user.id }, "callback: spotify login complete, code issued");
    clientRedirect.searchParams.set("code", ourAuthCode);
    res.redirect(302, clientRedirect.toString());
  });

  return router;
}
