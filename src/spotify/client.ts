import type { z } from "zod";
import type { Logger } from "../logger.js";
import {
  RateLimitedError,
  SpotifyApiError,
  SpotifyAuthError,
  SpotifyResponseShapeError,
} from "../util/errors.js";

/**
 * The only module that talks to Spotify over the network (Section 7).
 * Handles transparent token refresh, single retry on 401, bounded 429
 * backoff, and Zod-validated responses. Dead endpoints (audio-features,
 * audio-analysis, recommendations) are deliberately not exposed anywhere.
 */

export const SPOTIFY_API_BASE_URL = "https://api.spotify.com/v1";

export interface TokenProvider {
  /** Returns a currently valid access token, refreshing proactively if close to expiry. */
  getAccessToken(): Promise<string>;
  /** Forces a refresh (called after an unexpected 401). Returns the new token. */
  refreshAccessToken(): Promise<string>;
}

export interface SpotifyClientOptions {
  tokenProvider: TokenProvider;
  logger: Logger;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Max retries after 429 responses. */
  maxRateLimitRetries?: number;
  /** Never sleep longer than this per 429, seconds. */
  maxRetryAfterSeconds?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions<T> {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  schema?: z.ZodType<T>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SpotifyClient {
  private readonly tokenProvider: TokenProvider;
  private readonly logger: Logger;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRateLimitRetries: number;
  private readonly maxRetryAfterSeconds: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: SpotifyClientOptions) {
    this.tokenProvider = options.tokenProvider;
    this.logger = options.logger;
    this.baseUrl = (options.apiBaseUrl ?? SPOTIFY_API_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? 2;
    this.maxRetryAfterSeconds = options.maxRetryAfterSeconds ?? 30;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async request<T = unknown>(path: string, options: RequestOptions<T> = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    let token = await this.tokenProvider.getAccessToken();
    let refreshed = false;
    let rateLimitRetries = 0;

    for (;;) {
      const response = await this.send(url, token, options);

      if (response.status === 401 && !refreshed) {
        refreshed = true;
        this.logger.debug({ path }, "spotify 401, refreshing token and retrying once");
        token = await this.tokenProvider.refreshAccessToken();
        continue;
      }
      if (response.status === 401) {
        throw new SpotifyAuthError();
      }

      if (response.status === 429) {
        if (rateLimitRetries >= this.maxRateLimitRetries) {
          throw new RateLimitedError(this.retryAfterSeconds(response));
        }
        rateLimitRetries += 1;
        const waitSeconds = Math.min(
          this.retryAfterSeconds(response) ?? 1,
          this.maxRetryAfterSeconds,
        );
        this.logger.warn({ path, waitSeconds, attempt: rateLimitRetries }, "spotify 429, backing off");
        await this.sleep(waitSeconds * 1000);
        continue;
      }

      if (!response.ok) {
        throw new SpotifyApiError(
          `Spotify returned ${response.status} for ${options.method ?? "GET"} ${path}`,
          response.status,
          await this.extractReason(response),
        );
      }

      if (response.status === 204) {
        return undefined as T;
      }

      const text = await response.text();
      if (text.length === 0) {
        return undefined as T;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new SpotifyResponseShapeError(path, "response was not valid JSON");
      }
      if (!options.schema) {
        return json as T;
      }
      const parsed = options.schema.safeParse(json);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        throw new SpotifyResponseShapeError(path, detail);
      }
      return parsed.data;
    }
  }

  /**
   * Walks `offset` pagination for the caller, respecting per-request caps
   * (search allows at most 10 per request post Feb 2026) up to `total` items.
   */
  async paginate<T>(
    fetchPage: (limit: number, offset: number) => Promise<{ items: T[]; next?: boolean }>,
    { total, perRequest }: { total: number; perRequest: number },
  ): Promise<T[]> {
    const collected: T[] = [];
    let offset = 0;
    while (collected.length < total) {
      const limit = Math.min(perRequest, total - collected.length);
      const page = await fetchPage(limit, offset);
      collected.push(...page.items);
      if (page.items.length < limit || page.next === false) {
        break;
      }
      offset += page.items.length;
    }
    return collected.slice(0, total);
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private async send(
    url: string,
    token: string,
    options: RequestOptions<unknown>,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    return this.fetchImpl(url, {
      method: options.method ?? "GET",
      headers,
      ...(body !== undefined ? { body } : {}),
    });
  }

  private retryAfterSeconds(response: Response): number | undefined {
    const header = response.headers.get("Retry-After");
    if (header === null) return undefined;
    const parsed = Number(header);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }

  /** Pulls a machine-readable reason out of an error body without logging it raw. */
  private async extractReason(response: Response): Promise<string | undefined> {
    try {
      const body = (await response.json()) as {
        error?: { reason?: string; message?: string };
      };
      return body.error?.reason ?? body.error?.message;
    } catch {
      return undefined;
    }
  }
}
