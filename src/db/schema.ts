import {
  boolean,
  customType,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** All tables from spotifymcp.md Section 5. Timestamps are UTC. */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  spotifyUserId: text("spotify_user_id").notNull().unique(),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

export const spotifyTokens = pgTable("spotify_tokens", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  accessTokenEnc: bytea("access_token_enc").notNull(),
  refreshTokenEnc: bytea("refresh_token_enc").notNull(),
  accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }).notNull(),
  scope: text("scope").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mcpClients = pgTable("mcp_clients", {
  clientId: text("client_id").primaryKey(),
  clientSecretEnc: bytea("client_secret_enc"),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  clientName: text("client_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const authSessions = pgTable("auth_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: text("client_id").notNull(),
  clientRedirectUri: text("client_redirect_uri").notNull(),
  clientState: text("client_state"),
  clientCodeChallenge: text("client_code_challenge").notNull(),
  clientCodeChallengeMethod: text("client_code_challenge_method").notNull().default("S256"),
  spotifyState: text("spotify_state").notNull().unique(),
  userId: uuid("user_id").references(() => users.id),
  ourAuthCode: text("our_auth_code").unique(),
  status: text("status", {
    enum: ["pending", "spotify_returned", "code_issued", "consumed"],
  })
    .notNull()
    .default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mcpTokens = pgTable("mcp_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  clientId: text("client_id").notNull(),
  refreshTokenHash: text("refresh_token_hash").notNull().unique(),
  accessTokenJti: text("access_token_jti"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revoked: boolean("revoked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const listeningSnapshots = pgTable("listening_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  kind: text("kind", {
    enum: ["recently_played", "top_tracks", "top_artists"],
  }).notNull(),
  payload: jsonb("payload").notNull(),
});

export const cacheEntries = pgTable("cache_entries", {
  cacheKey: text("cache_key").primaryKey(),
  userId: uuid("user_id").references(() => users.id),
  payload: jsonb("payload").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
