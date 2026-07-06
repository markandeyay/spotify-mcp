import { Router, json, urlencoded } from "express";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { AUTH_SESSION_TTL_MS, type AuthDeps } from "./deps.js";
import { randomToken, sha256Hex, verifyS256 } from "./pkce.js";
import { authSessions, mcpTokens } from "../db/schema.js";

/**
 * POST /token: issues and rotates the tokens WE give to MCP clients.
 * authorization_code validates our single-use code plus PKCE; refresh_token
 * rotates on every use. Access tokens are short-lived HS256 JWTs.
 */

const codeGrantSchema = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().min(1),
  code_verifier: z.string().min(43).max(128),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
});

const refreshGrantSchema = z.object({
  grant_type: z.literal("refresh_token"),
  refresh_token: z.string().min(1),
  client_id: z.string().min(1),
});

function oauthError(status: number, error: string, description: string) {
  return { status, body: { error, error_description: description } };
}

export function tokenRouter(deps: AuthDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const signingKey = new TextEncoder().encode(deps.config.JWT_SIGNING_KEY);
  const issuer = deps.config.PUBLIC_BASE_URL;

  async function issueTokens(userId: string, clientId: string) {
    const jti = randomUUID();
    const expiresInSeconds = deps.config.TOKEN_ACCESS_TTL_SECONDS;
    const accessToken = await new SignJWT({ cid: clientId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuer(issuer)
      .setAudience(`${issuer}/mcp`)
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime(Math.floor(now().getTime() / 1000) + expiresInSeconds)
      .sign(signingKey);
    const refreshToken = randomToken(32);
    return { accessToken, refreshToken, refreshTokenHash: sha256Hex(refreshToken), jti, expiresInSeconds };
  }

  router.post("/token", urlencoded({ extended: false }), json(), async (req, res) => {
    const body = req.body as Record<string, unknown>;

    if (body.grant_type === "authorization_code") {
      const parsed = codeGrantSchema.safeParse(body);
      if (!parsed.success) {
        const err = oauthError(400, "invalid_request", "code, code_verifier, client_id, redirect_uri are required");
        res.status(err.status).json(err.body);
        return;
      }
      const params = parsed.data;

      const sessions = await deps.db
        .select()
        .from(authSessions)
        .where(eq(authSessions.ourAuthCode, params.code))
        .limit(1);
      const session = sessions[0];
      const fail = (description: string) => {
        const err = oauthError(400, "invalid_grant", description);
        res.status(err.status).json(err.body);
      };
      if (!session || session.status !== "code_issued" || session.userId === null) {
        fail("Authorization code is invalid or already used.");
        return;
      }
      // Single use: consume immediately so a race cannot redeem twice.
      const consumed = await deps.db
        .update(authSessions)
        .set({ status: "consumed" })
        .where(and(eq(authSessions.id, session.id), eq(authSessions.status, "code_issued")))
        .returning({ id: authSessions.id });
      if (consumed.length === 0) {
        fail("Authorization code is invalid or already used.");
        return;
      }
      if (now().getTime() - session.createdAt.getTime() > AUTH_SESSION_TTL_MS) {
        fail("Authorization code expired; please re-authorize.");
        return;
      }
      if (session.clientId !== params.client_id) {
        fail("client_id does not match the authorization request.");
        return;
      }
      if (session.clientRedirectUri !== params.redirect_uri) {
        fail("redirect_uri does not match the authorization request.");
        return;
      }
      if (!verifyS256(params.code_verifier, session.clientCodeChallenge)) {
        fail("PKCE verification failed.");
        return;
      }

      const issued = await issueTokens(session.userId, session.clientId);
      await deps.db.insert(mcpTokens).values({
        userId: session.userId,
        clientId: session.clientId,
        refreshTokenHash: issued.refreshTokenHash,
        accessTokenJti: issued.jti,
        expiresAt: new Date(now().getTime() + deps.config.TOKEN_REFRESH_TTL_SECONDS * 1000),
      });
      deps.logger.info({ userId: session.userId, clientId: session.clientId }, "token: code grant redeemed");
      res.json({
        access_token: issued.accessToken,
        token_type: "Bearer",
        expires_in: issued.expiresInSeconds,
        refresh_token: issued.refreshToken,
      });
      return;
    }

    if (body.grant_type === "refresh_token") {
      const parsed = refreshGrantSchema.safeParse(body);
      if (!parsed.success) {
        const err = oauthError(400, "invalid_request", "refresh_token and client_id are required");
        res.status(err.status).json(err.body);
        return;
      }
      const params = parsed.data;
      const hash = sha256Hex(params.refresh_token);
      const rows = await deps.db
        .select()
        .from(mcpTokens)
        .where(eq(mcpTokens.refreshTokenHash, hash))
        .limit(1);
      const record = rows[0];
      const fail = (description: string) => {
        const err = oauthError(400, "invalid_grant", description);
        res.status(err.status).json(err.body);
      };
      if (!record || record.revoked) {
        fail("Refresh token is invalid or revoked.");
        return;
      }
      if (record.clientId !== params.client_id) {
        fail("Refresh token does not belong to this client.");
        return;
      }
      if (record.expiresAt.getTime() <= now().getTime()) {
        fail("Refresh token expired; please re-authorize.");
        return;
      }

      // Rotate: the presented token is retired atomically with reissue.
      const issued = await issueTokens(record.userId, record.clientId);
      const rotated = await deps.db
        .update(mcpTokens)
        .set({
          refreshTokenHash: issued.refreshTokenHash,
          accessTokenJti: issued.jti,
          expiresAt: new Date(now().getTime() + deps.config.TOKEN_REFRESH_TTL_SECONDS * 1000),
        })
        .where(and(eq(mcpTokens.id, record.id), eq(mcpTokens.refreshTokenHash, hash)))
        .returning({ id: mcpTokens.id });
      if (rotated.length === 0) {
        fail("Refresh token is invalid or revoked.");
        return;
      }
      deps.logger.info({ userId: record.userId }, "token: refresh grant rotated");
      res.json({
        access_token: issued.accessToken,
        token_type: "Bearer",
        expires_in: issued.expiresInSeconds,
        refresh_token: issued.refreshToken,
      });
      return;
    }

    const err = oauthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
    res.status(err.status).json(err.body);
  });

  return router;
}
