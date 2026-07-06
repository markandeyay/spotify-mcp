import { z } from "zod";

/**
 * Loads and validates every environment variable listed in spotifymcp.md
 * Section 13. The server must not boot with a missing or malformed value.
 */

const base64Key32Bytes = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        return Buffer.from(value, "base64").length === 32;
      } catch {
        return false;
      }
    },
    { message: "must be a base64-encoded 32-byte key" },
  );

const httpsUrl = z
  .url()
  .transform((value) => value.replace(/\/+$/, ""));

export const envSchema = z.object({
  // HTTP port. Hosts like Render inject this.
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Public HTTPS URL of this server, used for redirect URIs and OAuth metadata.
  PUBLIC_BASE_URL: httpsUrl,
  // Neon Postgres connection string.
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => value.startsWith("postgres"), {
      message: "must be a postgres:// or postgresql:// connection string",
    }),
  // The single owner-registered Spotify app.
  SPOTIFY_CLIENT_ID: z.string().min(1),
  SPOTIFY_CLIENT_SECRET: z.string().min(1),
  // Must equal `${PUBLIC_BASE_URL}/callback` and be registered in the Spotify dashboard.
  SPOTIFY_REDIRECT_URI: z.url(),
  // 32-byte base64 key for AES-256-GCM encryption of Spotify tokens at rest.
  MASTER_ENCRYPTION_KEY: base64Key32Bytes,
  // Key for signing the access tokens this server issues to MCP clients.
  JWT_SIGNING_KEY: z.string().min(32, "must be at least 32 characters"),
  // Lifetime of issued access tokens, in seconds.
  TOKEN_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  // Lifetime of issued refresh tokens, in seconds. Default 30 days.
  TOKEN_REFRESH_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 24 * 60 * 60),
  // pino log level.
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export type Config = z.infer<typeof envSchema>;

/** Parses the given environment. Throws ZodError on invalid input. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return envSchema.parse(env);
}

/**
 * Parses the environment and exits the process with a readable, per-variable
 * error report if anything is missing or malformed. Never echoes values,
 * only variable names and what is wrong with them.
 */
export function loadConfigOrExit(env: NodeJS.ProcessEnv): Config {
  const result = envSchema.safeParse(env);
  if (result.success) {
    return result.data;
  }
  console.error("Invalid environment configuration. Fix the following and restart:");
  for (const issue of result.error.issues) {
    const name = issue.path.join(".") || "(root)";
    console.error(`  - ${name}: ${issue.message}`);
  }
  console.error("See .env.example for the full list of required variables.");
  process.exit(1);
}
