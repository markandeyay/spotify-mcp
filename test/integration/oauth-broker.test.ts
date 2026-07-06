import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startFakeSpotify, type FakeSpotify } from "../helpers/fake-spotify.js";
import { startTestApp, type TestApp } from "../helpers/test-app.js";
import { codeChallengeS256, generateCodeVerifier } from "../../src/auth/pkce.js";
import { spotifyTokens, users } from "../../src/db/schema.js";

/**
 * Phase 3 acceptance: a full OAuth walk (scripted client standing in for
 * Claude) yields a working bearer token that resolves to the correct user.
 */

describe("OAuth broker end to end", () => {
  let spotify: FakeSpotify;
  let app: TestApp;

  beforeAll(async () => {
    spotify = await startFakeSpotify();
    app = await startTestApp({ spotify: spotify.endpoints });
  });

  afterAll(async () => {
    await app.close();
    await spotify.close();
  });

  const CLIENT_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

  async function registerClient(): Promise<string> {
    const response = await fetch(`${app.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [CLIENT_REDIRECT],
        client_name: "Test Claude",
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { client_id: string };
    return body.client_id;
  }

  /** Walks register -> authorize -> spotify -> callback -> token. */
  async function fullWalk(spotifyUser: { id: string; display_name?: string }) {
    const clientId = await registerClient();
    const verifier = generateCodeVerifier();
    const state = `client-state-${spotifyUser.id}`;

    const authorizeUrl = new URL(`${app.baseUrl}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", CLIENT_REDIRECT);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", codeChallengeS256(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" });
    expect(authorizeResponse.status).toBe(302);
    const spotifyRedirect = new URL(authorizeResponse.headers.get("location")!);
    expect(spotifyRedirect.toString().startsWith(spotify.endpoints.authorizeUrl)).toBe(true);
    expect(spotifyRedirect.searchParams.get("client_id")).toBe("spotify-app-id");
    const spotifyState = spotifyRedirect.searchParams.get("state")!;

    // Simulate the user approving on Spotify: Spotify redirects to /callback.
    const spotifyCode = `spotify-code-${spotifyUser.id}`;
    spotify.issueCode(spotifyCode, spotifyUser);
    const callbackUrl = new URL(`${app.baseUrl}/callback`);
    callbackUrl.searchParams.set("code", spotifyCode);
    callbackUrl.searchParams.set("state", spotifyState);
    const callbackResponse = await fetch(callbackUrl, { redirect: "manual" });
    expect(callbackResponse.status).toBe(302);
    const clientRedirect = new URL(callbackResponse.headers.get("location")!);
    expect(clientRedirect.origin + clientRedirect.pathname).toBe(CLIENT_REDIRECT);
    expect(clientRedirect.searchParams.get("state")).toBe(state);
    const ourCode = clientRedirect.searchParams.get("code")!;
    expect(ourCode).toBeTruthy();

    const tokenResponse = await fetch(`${app.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: ourCode,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: CLIENT_REDIRECT,
      }).toString(),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    };
    return { tokens, clientId, ourCode, verifier };
  }

  it("discovery metadata advertises the broker endpoints", async () => {
    const resource = await fetch(`${app.baseUrl}/.well-known/oauth-protected-resource`);
    expect(resource.status).toBe(200);
    const resourceBody = (await resource.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(resourceBody.resource).toBe("https://mcp.example.test/mcp");
    expect(resourceBody.authorization_servers).toEqual(["https://mcp.example.test"]);

    const authServer = await fetch(`${app.baseUrl}/.well-known/oauth-authorization-server`);
    const authBody = (await authServer.json()) as Record<string, unknown>;
    expect(authBody.authorization_endpoint).toBe("https://mcp.example.test/authorize");
    expect(authBody.token_endpoint).toBe("https://mcp.example.test/token");
    expect(authBody.registration_endpoint).toBe("https://mcp.example.test/register");
    expect(authBody.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("completes the full brokered walk and the bearer resolves to the right user", async () => {
    const { tokens } = await fullWalk({ id: "spotify-mark", display_name: "Mark" });
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.refresh_token).toBeTruthy();

    const whoami = await fetch(`${app.baseUrl}/whoami`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(whoami.status).toBe(200);
    const identity = (await whoami.json()) as { spotify_user_id: string; display_name: string };
    expect(identity.spotify_user_id).toBe("spotify-mark");
    expect(identity.display_name).toBe("Mark");

    // The upstream exchange used our confidential Spotify credentials.
    const lastExchange = spotify.tokenExchanges.at(-1)!;
    expect(lastExchange.authorization).toBe(
      "Basic " + Buffer.from("spotify-app-id:spotify-app-secret").toString("base64"),
    );

    // Spotify tokens are stored encrypted, never plaintext.
    const userRows = await app.db
      .select()
      .from(users)
      .where(eq(users.spotifyUserId, "spotify-mark"));
    const tokenRows = await app.db
      .select()
      .from(spotifyTokens)
      .where(eq(spotifyTokens.userId, userRows[0]!.id));
    const atRest = Buffer.from(tokenRows[0]!.accessTokenEnc).toString("utf8");
    expect(atRest).not.toContain("sp-access");
  });

  it("rejects a wrong PKCE verifier", async () => {
    const clientId = await registerClient();
    const verifier = generateCodeVerifier();
    const authorizeUrl = new URL(`${app.baseUrl}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", CLIENT_REDIRECT);
    authorizeUrl.searchParams.set("code_challenge", codeChallengeS256(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" });
    const spotifyState = new URL(authorizeResponse.headers.get("location")!).searchParams.get(
      "state",
    )!;
    spotify.issueCode("code-pkce-test", { id: "pkce-user" });
    const callbackResponse = await fetch(
      `${app.baseUrl}/callback?code=code-pkce-test&state=${spotifyState}`,
      { redirect: "manual" },
    );
    const ourCode = new URL(callbackResponse.headers.get("location")!).searchParams.get("code")!;

    const tokenResponse = await fetch(`${app.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: ourCode,
        code_verifier: generateCodeVerifier(), // wrong verifier
        client_id: clientId,
        redirect_uri: CLIENT_REDIRECT,
      }).toString(),
    });
    expect(tokenResponse.status).toBe(400);
    const body = (await tokenResponse.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  it("rejects reuse of an authorization code", async () => {
    const { tokens: _first, clientId, ourCode, verifier } = await fullWalk({
      id: "reuse-user",
    });
    const replay = await fetch(`${app.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: ourCode,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: CLIENT_REDIRECT,
      }).toString(),
    });
    expect(replay.status).toBe(400);
  });

  it("rejects an unregistered redirect_uri at /authorize without redirecting", async () => {
    const clientId = await registerClient();
    const authorizeUrl = new URL(`${app.baseUrl}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", "https://evil.example.com/steal");
    authorizeUrl.searchParams.set("code_challenge", codeChallengeS256(generateCodeVerifier()));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(400);
  });

  it("rejects an unknown spotify state at /callback", async () => {
    const response = await fetch(`${app.baseUrl}/callback?code=x&state=forged-state`, {
      redirect: "manual",
    });
    expect(response.status).toBe(400);
  });

  it("rotates refresh tokens and invalidates the used one", async () => {
    const { tokens, clientId } = await fullWalk({ id: "refresh-user" });

    const refresh1 = await fetch(`${app.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      }).toString(),
    });
    expect(refresh1.status).toBe(200);
    const rotated = (await refresh1.json()) as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);

    // Old refresh token must now be dead.
    const replay = await fetch(`${app.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      }).toString(),
    });
    expect(replay.status).toBe(400);

    // New access token still resolves the same user.
    const whoami = await fetch(`${app.baseUrl}/whoami`, {
      headers: { Authorization: `Bearer ${rotated.access_token}` },
    });
    const identity = (await whoami.json()) as { spotify_user_id: string };
    expect(identity.spotify_user_id).toBe("refresh-user");
  });

  it("returns 401 with WWW-Authenticate metadata pointer when unauthenticated", async () => {
    const response = await fetch(`${app.baseUrl}/whoami`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"',
    );
  });

  it("rejects a garbage bearer token", async () => {
    const response = await fetch(`${app.baseUrl}/whoami`, {
      headers: { Authorization: "Bearer not-a-real-jwt" },
    });
    expect(response.status).toBe(401);
  });
});

describe("auth session expiry", () => {
  it("rejects a code redeemed after the 10 minute session TTL", async () => {
    const spotify = await startFakeSpotify();
    let offsetMs = 0;
    const app = await startTestApp({
      spotify: spotify.endpoints,
      now: () => new Date(Date.now() + offsetMs),
    });
    try {
      const clientRedirect = "https://claude.ai/api/mcp/auth_callback";
      const registerResponse = await fetch(`${app.baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [clientRedirect] }),
      });
      const { client_id: clientId } = (await registerResponse.json()) as { client_id: string };
      const verifier = generateCodeVerifier();
      const authorizeUrl = new URL(`${app.baseUrl}/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", clientId);
      authorizeUrl.searchParams.set("redirect_uri", clientRedirect);
      authorizeUrl.searchParams.set("code_challenge", codeChallengeS256(verifier));
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" });
      const spotifyState = new URL(
        authorizeResponse.headers.get("location")!,
      ).searchParams.get("state")!;
      spotify.issueCode("expiry-code", { id: "expiry-user" });
      const callbackResponse = await fetch(
        `${app.baseUrl}/callback?code=expiry-code&state=${spotifyState}`,
        { redirect: "manual" },
      );
      const ourCode = new URL(callbackResponse.headers.get("location")!).searchParams.get(
        "code",
      )!;

      offsetMs = 11 * 60 * 1000; // jump past the TTL
      const tokenResponse = await fetch(`${app.baseUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: ourCode,
          code_verifier: verifier,
          client_id: clientId,
          redirect_uri: clientRedirect,
        }).toString(),
      });
      expect(tokenResponse.status).toBe(400);
    } finally {
      await app.close();
      await spotify.close();
    }
  });
});
