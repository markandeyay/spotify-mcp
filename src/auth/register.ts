import { Router, json } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthDeps } from "./deps.js";
import { mcpClients } from "../db/schema.js";

/**
 * Dynamic client registration (RFC 7591). Registered clients are public
 * clients using PKCE; no client secret is issued (Decisions Log 2026-07-05).
 */

const registrationSchema = z.object({
  redirect_uris: z.array(z.url()).min(1),
  client_name: z.string().max(200).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

function isAcceptableRedirect(uri: string): boolean {
  const parsed = new URL(uri);
  if (parsed.protocol === "https:") return true;
  // Allow loopback redirects for local development clients (OAuth 2.1 permits these over http).
  return (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  );
}

export function registerRouter(deps: AuthDeps): Router {
  const router = Router();

  router.post("/register", json(), async (req, res) => {
    const parsed = registrationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_client_metadata",
        error_description: "redirect_uris (array of URLs) is required",
      });
      return;
    }
    const { redirect_uris, client_name } = parsed.data;
    if (!redirect_uris.every(isAcceptableRedirect)) {
      res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be https or http on localhost",
      });
      return;
    }

    const clientId = randomUUID();
    await deps.db.insert(mcpClients).values({
      clientId,
      redirectUris: redirect_uris,
      clientName: client_name ?? null,
    });
    deps.logger.info({ clientId, redirectCount: redirect_uris.length }, "registered mcp client");

    res.status(201).json({
      client_id: clientId,
      redirect_uris,
      client_name,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  return router;
}
