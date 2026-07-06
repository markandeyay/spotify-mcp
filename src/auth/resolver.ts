import type { NextFunction, Request, RequestHandler, Response } from "express";
import { jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import type { AuthDeps } from "./deps.js";
import { users } from "../db/schema.js";

/**
 * Bearer-token resolver middleware (Section 6.4). Verifies the JWT we issued,
 * loads the internal user, and attaches it to the request. On failure returns
 * 401 with WWW-Authenticate pointing at the protected-resource metadata so
 * MCP clients know where to start the OAuth flow.
 */

export interface AuthenticatedUser {
  id: string;
  spotifyUserId: string;
  displayName: string | null;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthenticatedUser;
  }
}

export function requireAuth(deps: AuthDeps): RequestHandler {
  const signingKey = new TextEncoder().encode(deps.config.JWT_SIGNING_KEY);
  const issuer = deps.config.PUBLIC_BASE_URL;

  return async (req: Request, res: Response, next: NextFunction) => {
    const unauthorized = (description: string) => {
      res
        .status(401)
        .set(
          "WWW-Authenticate",
          `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource", error="invalid_token", error_description="${description}"`,
        )
        .json({ error: "invalid_token", error_description: description });
    };

    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      unauthorized("Missing bearer token");
      return;
    }
    const token = header.slice("Bearer ".length);

    let userId: string;
    try {
      const { payload } = await jwtVerify(token, signingKey, {
        issuer,
        audience: `${issuer}/mcp`,
      });
      if (typeof payload.sub !== "string") {
        unauthorized("Token has no subject");
        return;
      }
      userId = payload.sub;
    } catch {
      unauthorized("Token is invalid or expired");
      return;
    }

    const rows = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = rows[0];
    if (!user) {
      unauthorized("Unknown user");
      return;
    }
    req.user = {
      id: user.id,
      spotifyUserId: user.spotifyUserId,
      displayName: user.displayName,
    };
    next();
  };
}
