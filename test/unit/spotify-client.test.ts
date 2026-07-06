import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SpotifyClient, type TokenProvider } from "../../src/spotify/client.js";
import { createLogger } from "../../src/logger.js";
import {
  RateLimitedError,
  SpotifyAuthError,
  SpotifyResponseShapeError,
} from "../../src/util/errors.js";
import { Writable } from "node:stream";

const silentLogger = createLogger(
  "silent",
  new Writable({ write: (_c, _e, cb) => cb() }),
);

function tokenProvider(overrides: Partial<TokenProvider> = {}): TokenProvider {
  return {
    getAccessToken: vi.fn().mockResolvedValue("token-1"),
    refreshAccessToken: vi.fn().mockResolvedValue("token-2"),
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function makeClient(fetchImpl: typeof fetch, provider = tokenProvider()) {
  return {
    client: new SpotifyClient({
      tokenProvider: provider,
      logger: silentLogger,
      apiBaseUrl: "https://fake.spotify.test/v1",
      fetchImpl,
      sleep: async () => {},
    }),
    provider,
  };
}

describe("SpotifyClient", () => {
  it("sends the bearer token and parses through the schema", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: "u1" }));
    const { client } = makeClient(fetchImpl as typeof fetch);

    const result = await client.request("/me", { schema: z.object({ id: z.string() }) });

    expect(result).toEqual({ id: "u1" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://fake.spotify.test/v1/me");
    expect(init.headers.Authorization).toBe("Bearer token-1");
  });

  it("refreshes once on 401 and retries with the new token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: { message: "expired" } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const { client, provider } = makeClient(fetchImpl as typeof fetch);

    const result = await client.request<{ ok: boolean }>("/me");

    expect(result).toEqual({ ok: true });
    expect(provider.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[1]![1].headers.Authorization).toBe("Bearer token-2");
  });

  it("throws SpotifyAuthError when the retry after refresh still yields 401", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, {}));
    const { client } = makeClient(fetchImpl as typeof fetch);

    await expect(client.request("/me")).rejects.toBeInstanceOf(SpotifyAuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("backs off on 429 honoring Retry-After, then succeeds", async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}, { "Retry-After": "3" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const provider = tokenProvider();
    const client = new SpotifyClient({
      tokenProvider: provider,
      logger: silentLogger,
      apiBaseUrl: "https://fake.spotify.test/v1",
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await client.request<{ ok: boolean }>("/search");

    expect(result).toEqual({ ok: true });
    expect(sleeps).toEqual([3000]);
  });

  it("gives up with RateLimitedError after bounded 429 retries", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(429, {}, { "Retry-After": "1" }));
    const { client } = makeClient(fetchImpl as typeof fetch);

    await expect(client.request("/search")).rejects.toBeInstanceOf(RateLimitedError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("recovers a concurrent burst once the rate-limit window passes", async () => {
    // Simulated load: the first 5 attempts land inside a rate-limit window
    // and get 429; everything after it succeeds.
    let attempts = 0;
    const sleeps: number[] = [];
    const fetchImpl = vi.fn().mockImplementation(async () => {
      attempts += 1;
      return attempts <= 5
        ? jsonResponse(429, {}, { "Retry-After": "2" })
        : jsonResponse(200, { ok: true });
    });
    const client = new SpotifyClient({
      tokenProvider: tokenProvider(),
      logger: silentLogger,
      apiBaseUrl: "https://fake.spotify.test/v1",
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => client.request<{ ok: boolean }>("/search")),
    );

    expect(results).toEqual(Array.from({ length: 5 }, () => ({ ok: true })));
    // Every retry honored Retry-After, and the total attempt count stayed
    // bounded (at most 3 per request) instead of hammering the API.
    expect(sleeps.every((ms) => ms === 2000)).toBe(true);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(15);
  });

  it("caps a huge Retry-After at maxRetryAfterSeconds", async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}, { "Retry-After": "9999" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const client = new SpotifyClient({
      tokenProvider: tokenProvider(),
      logger: silentLogger,
      apiBaseUrl: "https://fake.spotify.test/v1",
      fetchImpl: fetchImpl as typeof fetch,
      maxRetryAfterSeconds: 30,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await client.request("/search");
    expect(sleeps).toEqual([30000]);
  });

  it("throws SpotifyResponseShapeError when the schema rejects the body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { unexpected: true }));
    const { client } = makeClient(fetchImpl as typeof fetch);

    await expect(
      client.request("/me", { schema: z.object({ id: z.string() }) }),
    ).rejects.toBeInstanceOf(SpotifyResponseShapeError);
  });

  it("returns undefined for a 204 with no body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const { client } = makeClient(fetchImpl as typeof fetch);

    await expect(client.request("/me/player")).resolves.toBeUndefined();
  });

  it("paginate walks offsets and respects the total cap", async () => {
    const { client } = makeClient(vi.fn() as never);
    const pages: Record<number, string[]> = {
      0: ["a", "b", "c"],
      3: ["d", "e", "f"],
      6: ["g"],
    };
    const fetchPage = vi.fn(async (limit: number, offset: number) => ({
      items: (pages[offset] ?? []).slice(0, limit),
    }));

    const result = await client.paginate(fetchPage, { total: 7, perRequest: 3 });

    expect(result).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("paginate stops early when a short page signals the end", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: ["a", "b"] })
      .mockResolvedValue({ items: [] });
    const { client } = makeClient(vi.fn() as never);

    const result = await client.paginate(fetchPage, { total: 10, perRequest: 5 });

    expect(result).toEqual(["a", "b"]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
