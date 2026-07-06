import express from "express";
import type { Server } from "node:http";
import type { SpotifyOAuthEndpoints } from "../../src/auth/deps.js";

/**
 * A minimal stand-in for Spotify's accounts service and API, good enough to
 * exercise the broker's upstream leg: token exchange with Basic auth and the
 * /me identity call.
 */

export interface FakeSpotify {
  endpoints: SpotifyOAuthEndpoints;
  baseUrl: string;
  /** Codes the fake will accept, mapped to the user they represent. */
  issueCode(code: string, user: { id: string; display_name?: string }): void;
  tokenExchanges: Array<{ code: string; authorization: string | undefined }>;
  close(): Promise<void>;
}

export async function startFakeSpotify(): Promise<FakeSpotify> {
  const app = express();
  const codes = new Map<string, { id: string; display_name?: string }>();
  const accessTokens = new Map<string, { id: string; display_name?: string }>();
  const tokenExchanges: FakeSpotify["tokenExchanges"] = [];
  let counter = 0;

  app.post("/api/token", express.urlencoded({ extended: false }), (req, res) => {
    const code = req.body.code as string;
    tokenExchanges.push({ code, authorization: req.headers.authorization });
    const user = codes.get(code);
    if (!user || req.body.grant_type !== "authorization_code") {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    codes.delete(code);
    counter += 1;
    const accessToken = `sp-access-${counter}`;
    accessTokens.set(accessToken, user);
    res.json({
      access_token: accessToken,
      refresh_token: `sp-refresh-${counter}`,
      expires_in: 3600,
      scope: "user-read-private user-top-read",
      token_type: "Bearer",
    });
  });

  app.get("/v1/me", (req, res) => {
    const token = (req.headers.authorization ?? "").replace("Bearer ", "");
    const user = accessTokens.get(token);
    if (!user) {
      res.status(401).json({ error: { status: 401, message: "invalid token" } });
      return;
    }
    res.json({ id: user.id, display_name: user.display_name ?? null });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    endpoints: {
      authorizeUrl: `${baseUrl}/authorize`,
      tokenUrl: `${baseUrl}/api/token`,
      apiBaseUrl: `${baseUrl}/v1`,
    },
    issueCode: (code, user) => codes.set(code, user),
    tokenExchanges,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
