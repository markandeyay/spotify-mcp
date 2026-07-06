import "dotenv/config";
import { pathToFileURL } from "node:url";
import express, { type Express } from "express";
import rateLimit from "express-rate-limit";
import { loadConfigOrExit, type Config } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { createDb, type Db } from "./db/client.js";
import { keyFromBase64 } from "./crypto/tokens.js";
import { REAL_SPOTIFY_OAUTH, type AuthDeps, type SpotifyOAuthEndpoints } from "./auth/deps.js";
import { metadataRouter } from "./auth/metadata.js";
import { registerRouter } from "./auth/register.js";
import { authorizeRouter } from "./auth/authorize.js";
import { callbackRouter } from "./auth/callback.js";
import { tokenRouter } from "./auth/token.js";
import { requireAuth } from "./auth/resolver.js";

/**
 * Entry point: builds the Express app, mounts routes, starts the server.
 * All external dependencies are injected through AppDeps so tests can supply
 * an in-memory database and a fake Spotify upstream.
 */

export interface AppDeps {
  config: Config;
  logger: Logger;
  db: Db;
  spotify?: SpotifyOAuthEndpoints;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Requests per minute per IP on /authorize, /token, /register. */
  authRateLimitPerMinute?: number;
}

export function createApp(deps: AppDeps): Express {
  const authDeps: AuthDeps = {
    db: deps.db,
    config: deps.config,
    logger: deps.logger,
    encryptionKey: keyFromBase64(deps.config.MASTER_ENCRYPTION_KEY),
    spotify: deps.spotify ?? REAL_SPOTIFY_OAUTH,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };

  const app = express();
  app.disable("x-powered-by");
  // Render and similar hosts terminate TLS at a proxy.
  app.set("trust proxy", 1);

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use(metadataRouter(deps.config.PUBLIC_BASE_URL));

  const authLimiter = rateLimit({
    windowMs: 60_000,
    limit: deps.authRateLimitPerMinute ?? 30,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(["/authorize", "/token", "/register"], authLimiter);

  app.use(registerRouter(authDeps));
  app.use(authorizeRouter(authDeps));
  app.use(callbackRouter(authDeps));
  app.use(tokenRouter(authDeps));

  // Small authenticated identity probe; also the Phase 3 acceptance check.
  app.get("/whoami", requireAuth(authDeps), (req, res) => {
    res.json({
      user_id: req.user!.id,
      spotify_user_id: req.user!.spotifyUserId,
      display_name: req.user!.displayName,
    });
  });

  return app;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const config = loadConfigOrExit(process.env);
  const logger = createLogger(config.LOG_LEVEL);
  const { db } = createDb(config.DATABASE_URL);
  const app = createApp({ config, logger, db });
  app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, "spotify-mcp server listening");
  });
}
