import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { createLogger } from "../../src/logger.js";

function captureStream(lines: string[]): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
}

describe("createLogger redaction", () => {
  it("redacts token and secret fields at multiple depths", () => {
    const lines: string[] = [];
    const logger = createLogger("info", captureStream(lines));

    logger.info(
      {
        access_token: "top-secret-access",
        nested: { refresh_token: "top-secret-refresh" },
        deeper: { inner: { client_secret: "top-secret-client" } },
      },
      "token exchange",
    );

    const output = lines.join("");
    expect(output).not.toContain("top-secret-access");
    expect(output).not.toContain("top-secret-refresh");
    expect(output).not.toContain("top-secret-client");
    expect(output).toContain("[REDACTED]");
  });

  it("redacts authorization headers", () => {
    const lines: string[] = [];
    const logger = createLogger("info", captureStream(lines));

    logger.info(
      { req: { headers: { authorization: "Bearer very-secret-jwt" } } },
      "incoming request",
    );

    expect(lines.join("")).not.toContain("very-secret-jwt");
  });

  it("leaves non-sensitive fields intact", () => {
    const lines: string[] = [];
    const logger = createLogger("info", captureStream(lines));

    logger.info({ port: 3000 }, "spotify-mcp server listening");

    const output = lines.join("");
    expect(output).toContain("3000");
    expect(output).toContain("spotify-mcp server listening");
  });
});
