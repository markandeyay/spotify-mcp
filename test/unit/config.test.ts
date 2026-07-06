import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../../src/config.js";

function validEnv(): NodeJS.ProcessEnv {
  return {
    PORT: "3000",
    PUBLIC_BASE_URL: "https://example.com",
    DATABASE_URL: "postgresql://user:pass@host/db",
    SPOTIFY_CLIENT_ID: "client-id",
    SPOTIFY_CLIENT_SECRET: "client-secret",
    SPOTIFY_REDIRECT_URI: "https://example.com/callback",
    MASTER_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    JWT_SIGNING_KEY: randomBytes(32).toString("hex"),
    TOKEN_ACCESS_TTL_SECONDS: "3600",
    TOKEN_REFRESH_TTL_SECONDS: "2592000",
    LOG_LEVEL: "info",
    NODE_ENV: "test",
  };
}

describe("loadConfig", () => {
  it("parses a fully valid environment", () => {
    const config = loadConfig(validEnv());
    expect(config.PORT).toBe(3000);
    expect(config.PUBLIC_BASE_URL).toBe("https://example.com");
    expect(config.TOKEN_ACCESS_TTL_SECONDS).toBe(3600);
  });

  it("applies defaults for optional variables", () => {
    const env = validEnv();
    delete env.PORT;
    delete env.TOKEN_ACCESS_TTL_SECONDS;
    delete env.TOKEN_REFRESH_TTL_SECONDS;
    delete env.LOG_LEVEL;
    delete env.NODE_ENV;
    const config = loadConfig(env);
    expect(config.PORT).toBe(3000);
    expect(config.TOKEN_ACCESS_TTL_SECONDS).toBe(3600);
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.NODE_ENV).toBe("development");
  });

  it("strips a trailing slash from PUBLIC_BASE_URL", () => {
    const env = validEnv();
    env.PUBLIC_BASE_URL = "https://example.com/";
    expect(loadConfig(env).PUBLIC_BASE_URL).toBe("https://example.com");
  });

  it("rejects a missing required variable", () => {
    const env = validEnv();
    delete env.SPOTIFY_CLIENT_SECRET;
    expect(() => loadConfig(env)).toThrow();
  });

  it("rejects a MASTER_ENCRYPTION_KEY that is not 32 bytes", () => {
    const env = validEnv();
    env.MASTER_ENCRYPTION_KEY = randomBytes(16).toString("base64");
    expect(() => loadConfig(env)).toThrow();
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    const env = validEnv();
    env.DATABASE_URL = "mysql://user:pass@host/db";
    expect(() => loadConfig(env)).toThrow();
  });

  it("rejects an invalid LOG_LEVEL", () => {
    const env = validEnv();
    env.LOG_LEVEL = "verbose";
    expect(() => loadConfig(env)).toThrow();
  });
});
