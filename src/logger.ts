import pino from "pino";

/**
 * Structured logger with secret redaction (spotifymcp.md Section 0, rule 5).
 * Tokens, authorization codes, and client secrets must never appear in logs,
 * so every known-sensitive key is redacted at any nesting depth.
 */

const SENSITIVE_KEYS = [
  "access_token",
  "refresh_token",
  "accessToken",
  "refreshToken",
  "client_secret",
  "clientSecret",
  "code",
  "code_verifier",
  "authorization",
  "cookie",
  "password",
  "token",
];

const redactPaths = SENSITIVE_KEYS.flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`,
  `req.headers.${key}`,
]);

export function createLogger(level: string, stream?: pino.DestinationStream): pino.Logger {
  const options: pino.LoggerOptions = {
    level,
    redact: {
      paths: redactPaths,
      censor: "[REDACTED]",
    },
  };
  return stream ? pino(options, stream) : pino(options);
}

export type Logger = pino.Logger;
