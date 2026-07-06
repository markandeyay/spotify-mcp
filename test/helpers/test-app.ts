import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { Writable } from "node:stream";
import { createApp, type AppDeps } from "../../src/index.js";
import type { Config } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { createTestDb } from "./test-db.js";
import type { SpotifyOAuthEndpoints } from "../../src/auth/deps.js";

export const silentLogger = createLogger(
  "silent",
  new Writable({ write: (_c, _e, cb) => cb() }),
);

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 0,
    PUBLIC_BASE_URL: "https://mcp.example.test",
    DATABASE_URL: "postgresql://unused",
    SPOTIFY_CLIENT_ID: "spotify-app-id",
    SPOTIFY_CLIENT_SECRET: "spotify-app-secret",
    SPOTIFY_REDIRECT_URI: "https://mcp.example.test/callback",
    MASTER_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    JWT_SIGNING_KEY: randomBytes(32).toString("hex"),
    TOKEN_ACCESS_TTL_SECONDS: 3600,
    TOKEN_REFRESH_TTL_SECONDS: 2592000,
    LOG_LEVEL: "silent" as Config["LOG_LEVEL"],
    NODE_ENV: "test",
    ...overrides,
  };
}

export interface TestApp {
  baseUrl: string;
  config: Config;
  db: Awaited<ReturnType<typeof createTestDb>>["db"];
  close(): Promise<void>;
}

export async function startTestApp(options: {
  spotify?: SpotifyOAuthEndpoints;
  config?: Partial<Config>;
  now?: () => Date;
} = {}): Promise<TestApp> {
  const { db, close: closeDb } = await createTestDb();
  const config = testConfig(options.config);
  const deps: AppDeps = {
    config,
    logger: silentLogger,
    db,
    authRateLimitPerMinute: 10_000,
    ...(options.spotify ? { spotify: options.spotify } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  const app = createApp(deps);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    config,
    db,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await closeDb();
    },
  };
}
