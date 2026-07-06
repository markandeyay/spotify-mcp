import { Router } from "express";

/**
 * Well-known OAuth metadata (RFC 9728 protected resource, RFC 8414
 * authorization server). Claude discovers the whole flow from these.
 */
export function metadataRouter(publicBaseUrl: string): Router {
  const router = Router();
  const base = publicBaseUrl.replace(/\/+$/, "");

  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      resource_name: "spotify-mcp",
    });
  });

  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [],
    });
  });

  return router;
}
