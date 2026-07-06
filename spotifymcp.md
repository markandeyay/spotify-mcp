# Spotify MCP Server: System Design and Build Plan

**Project codename:** `spotify-mcp`
**Deployment model:** Remote hosted MCP server with brokered Spotify OAuth (a single owner-registered Spotify app that all users authenticate through)
**Primary client:** Claude (custom connector), but any MCP-compliant client should work
**Author:** Markandeya Yalamanchi

---

## 0. How to use this document (read this first, coding agent)

This is the single source of truth for the build. Follow it in order.

**Rules for the agent:**

1. Work through the phases in `Section 14: Progress Tracker` from top to bottom. Do not skip ahead. Each phase has acceptance criteria that must pass before the next phase starts.
2. After completing any checklist item, edit this file and change its status marker (see legend below). Keep the tracker honest. It is the shared memory between sessions.
3. Spotify's Web API is a moving target. Several endpoints were removed or restricted in November 2024 and February 2026. Before implementing any endpoint call, verify it is still live against the current official docs at `https://developer.spotify.com/documentation/web-api`. `Section 12` lists known-dead and known-alive endpoints as of early 2026, but treat that as a starting hypothesis, not gospel. Build capability detection so the server degrades gracefully when an endpoint is gone.
4. Never hardcode secrets. Everything sensitive comes from environment variables. Maintain a `.env.example` with every required key and a one-line comment.
5. Never log tokens, authorization codes, or client secrets. Redact them in all log output.
6. Prefer small, well-typed modules over large files. Every external boundary (Spotify API, database, OAuth) gets its own module with typed inputs and outputs.
7. When a design decision is genuinely ambiguous or a verification step reveals this document is wrong, stop and flag it in `Section 15: Open Questions and Decisions Log` rather than guessing silently.
8. Write tests as you go, not at the end. A phase is not done until its tests pass.

**Status legend for the tracker:**

- `[ ]` not started
- `[~]` in progress
- `[x]` done and acceptance criteria met
- `[!]` blocked (add a note in the Decisions Log explaining why)

---

## 1. Goals and non-goals

### 1.1 Goals

The server should be meaningfully better than the existing open-source Spotify MCP servers, which are near-identical thin wrappers around playback, search, and playlist CRUD. Differentiation comes from three things:

1. **An intelligence layer.** Tools return pre-aggregated summaries (taste over time, playlist composition, library gaps) instead of dumping raw JSON into the model's context window. Computation happens on the server, not in the LLM.
2. **Statefulness over time.** The server snapshots listening history so it can answer questions that Spotify's API cannot answer in a single call, such as how a user's taste has shifted over months.
3. **Honesty about the 2026 API reality.** No dependence on the dead `audio-features`, `audio-analysis`, or `recommendations` endpoints. Graceful degradation when playback requires Premium or an active device.

### 1.2 Non-goals

- No scraping of Spotify. Official Web API only.
- No attempt to resurrect deprecated audio-feature data by scraping third-party sites. If mood or tempo inference is needed, it is derived from metadata the API still provides plus the calling model's own music knowledge, and this limitation is stated plainly in tool descriptions.
- Not a general music service. It manages the authenticated user's own account and reads public catalog data. It does not try to pull arbitrary other users' private data.
- No paid infrastructure required for v1. Everything runs on free tiers.

### 1.3 Success criteria for v1

- A user can add the server as a custom connector in Claude by pasting one URL, complete a Spotify login, and immediately use every tool.
- No JSON editing, no local install, no per-user Spotify developer app.
- All core tools work end to end against a real Spotify account.
- Token refresh is transparent. The user authenticates once and does not have to re-auth for the lifetime of a valid refresh token.

---

## 2. Tech stack

Chosen for reliability, free hosting, strong typing, and good coding-agent support. If the agent has a strong reason to deviate, record it in the Decisions Log first.

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript on Node.js 22 LTS | Best-supported MCP SDK, strong typing, huge training corpus for the agent |
| MCP framework | `@modelcontextprotocol/sdk` (official) | Streamable HTTP transport and OAuth helper primitives are built in |
| HTTP layer | Express | The official MCP SDK's Streamable HTTP examples use Express, so patterns are well documented |
| Transport | Streamable HTTP (MCP spec 2025-11-25 or later) | The current standard. SSE is being deprecated. Do not build SSE-only |
| Database | PostgreSQL via Neon (free tier) | Persistent across restarts, unlike ephemeral filesystems on free hosts |
| ORM / query | Drizzle ORM | Lightweight, type-safe, easy migrations |
| Cache | Postgres tables with TTL columns for v1; optional Upstash Redis later | Avoids adding a dependency before it is needed |
| Token encryption | Node `crypto` AES-256-GCM | Encrypt Spotify tokens at rest |
| Hosting | Render free web service (Fly.io or Railway acceptable alternatives) | Free public HTTPS URL, which the custom connector requires |
| Validation | Zod | Runtime validation of tool inputs and Spotify responses |
| Testing | Vitest plus MCP Inspector for manual tool runs | Fast, TS-native |
| Logging | pino with redaction | Structured logs, secret redaction built in |

**Language note:** an all-Rust build is possible and would play to your strengths, but the MCP OAuth and Streamable HTTP story is far more mature in the TypeScript SDK today. If you want Rust somewhere, the intelligence and aggregation layer is a reasonable candidate to port later behind a stable internal interface. For v1, keep it in TypeScript to avoid fighting immature tooling on the hardest part (auth).

---

## 3. High-level architecture

```
                         ┌──────────────────────────────────────────────┐
                         │                 Claude client                 │
                         │  (adds custom connector by URL, does OAuth)    │
                         └───────────────┬───────────────┬────────────────┘
                                         │               │
                          MCP calls      │               │  OAuth 2.1
                        (Bearer token)    │               │  (authorize / token / register)
                                         ▼               ▼
        ┌────────────────────────────────────────────────────────────────────────┐
        │                          spotify-mcp server                              │
        │                                                                          │
        │   ┌──────────────┐   ┌───────────────────┐   ┌────────────────────────┐ │
        │   │ MCP layer     │   │ OAuth broker       │   │ Well-known metadata     │ │
        │   │ (tools, HTTP  │   │ /authorize /token  │   │ /.well-known/*          │ │
        │   │  transport)   │   │ /register /callback│   │ (RFC 8414, RFC 9728)    │ │
        │   └──────┬───────┘   └─────────┬──────────┘   └────────────────────────┘ │
        │          │                     │                                          │
        │          ▼                     ▼                                          │
        │   ┌──────────────────────────────────────────────┐                       │
        │   │ Session / auth resolver                        │                      │
        │   │ (maps MCP bearer token -> internal user)       │                      │
        │   └──────────────┬─────────────────────────────────┘                     │
        │                  │                                                         │
        │   ┌──────────────▼───────────┐   ┌───────────────────────────────────┐    │
        │   │ Intelligence / aggregation│   │ Spotify API client                │    │
        │   │ layer (summaries, trends, │──▶│ (auto token refresh, retries,     │    │
        │   │  gap-finding)             │   │  rate-limit handling, pagination) │    │
        │   └──────────────┬───────────┘   └──────────────┬────────────────────┘    │
        │                  │                              │                          │
        │   ┌──────────────▼──────────────────────────────▼──────────────────────┐  │
        │   │ Data layer (Drizzle)                                                │  │
        │   │  users | spotify_tokens (encrypted) | mcp_clients | mcp_tokens      │  │
        │   │  auth_sessions | listening_snapshots | cache_entries                │  │
        │   └──────────────┬──────────────────────────────────────────────────────┘ │
        └──────────────────┼───────────────────────────────────────────────────────┘
                           ▼
                 ┌──────────────────┐         ┌────────────────────────┐
                 │ Neon Postgres     │         │ Spotify Web API + OAuth │
                 └──────────────────┘         └────────────────────────┘
```

Request paths:

- **Auth path:** Claude discovers the server needs auth, walks the OAuth 2.1 flow against the broker, which in turn brokers a Spotify login, then issues Claude its own bearer token.
- **Tool path:** Claude calls a tool with its bearer token. The session resolver maps that token to an internal user, loads and refreshes that user's Spotify tokens, and the tool runs through the intelligence layer and/or the Spotify client.

---

## 4. Directory structure

```
spotify-mcp/
├── spotifymcp.md                 # this document, kept updated
├── README.md                     # user-facing setup + usage
├── .env.example                  # every env var, documented
├── .gitignore                    # must ignore .env, dist, node_modules
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── src/
│   ├── index.ts                  # entry: builds Express app, mounts routes, starts server
│   ├── config.ts                 # loads + validates env with Zod, exits if invalid
│   ├── logger.ts                 # pino instance with redaction
│   ├── db/
│   │   ├── client.ts             # Drizzle + Neon connection
│   │   ├── schema.ts             # all tables
│   │   └── migrations/           # generated SQL migrations
│   ├── crypto/
│   │   └── tokens.ts             # AES-256-GCM encrypt/decrypt helpers
│   ├── auth/
│   │   ├── metadata.ts           # well-known endpoints
│   │   ├── authorize.ts          # /authorize -> redirect to Spotify
│   │   ├── callback.ts           # /callback from Spotify -> issue our code
│   │   ├── token.ts              # /token: exchange our code, refresh our tokens
│   │   ├── register.ts           # /register: dynamic client registration
│   │   ├── resolver.ts           # bearer token -> internal user
│   │   └── pkce.ts               # PKCE helpers
│   ├── spotify/
│   │   ├── client.ts             # low-level fetch wrapper: refresh, retry, backoff
│   │   ├── endpoints.ts          # typed functions per Spotify endpoint
│   │   ├── capabilities.ts       # runtime detection of alive endpoints + premium/device
│   │   └── types.ts              # Zod schemas for Spotify responses
│   ├── intelligence/
│   │   ├── summarize-library.ts
│   │   ├── summarize-playlist.ts
│   │   ├── listening-trends.ts
│   │   ├── find-gaps.ts
│   │   └── snapshots.ts          # capture + read listening history over time
│   ├── cache/
│   │   └── cache.ts              # get/set with TTL against cache_entries
│   ├── mcp/
│   │   ├── server.ts             # builds the McpServer, registers tools
│   │   ├── transport.ts          # Streamable HTTP wiring into Express
│   │   └── tools/
│   │       ├── context.ts        # get_initial_context
│   │       ├── search.ts
│   │       ├── info.ts
│   │       ├── playlists.ts
│   │       ├── playback.ts
│   │       ├── library.ts
│   │       └── insights.ts       # the intelligence-backed tools
│   └── util/
│       ├── errors.ts             # typed error classes + MCP error mapping
│       └── pagination.ts
├── test/
│   ├── unit/
│   ├── integration/
│   └── fixtures/                 # recorded Spotify responses
└── scripts/
    └── snapshot-cron.ts          # optional: periodic listening snapshot job
```

---

## 5. Data model

Use Drizzle. All timestamps are UTC. All token fields are stored encrypted (ciphertext plus IV plus auth tag), never plaintext.

### `users`
| column | type | notes |
|---|---|---|
| id | uuid pk | internal id |
| spotify_user_id | text unique | from Spotify `/me` |
| display_name | text | for friendly output |
| created_at | timestamptz | |
| last_seen_at | timestamptz | updated on each tool call |

### `spotify_tokens`
| column | type | notes |
|---|---|---|
| user_id | uuid pk fk users.id | one row per user |
| access_token_enc | bytea | encrypted |
| refresh_token_enc | bytea | encrypted |
| access_expires_at | timestamptz | when to refresh |
| scope | text | granted scopes |
| updated_at | timestamptz | |

### `mcp_clients` (dynamic client registration, RFC 7591)
| column | type | notes |
|---|---|---|
| client_id | text pk | issued by us |
| client_secret_enc | bytea nullable | for confidential clients; public clients use PKCE only |
| redirect_uris | jsonb | allowlist |
| created_at | timestamptz | |

### `auth_sessions` (transient, links Claude's flow to Spotify's)
| column | type | notes |
|---|---|---|
| id | uuid pk | our authorization code lives here |
| client_id | text | which MCP client |
| client_redirect_uri | text | validated against mcp_clients |
| client_state | text | echo back to client |
| client_code_challenge | text | PKCE from the MCP client |
| client_code_challenge_method | text | S256 |
| spotify_state | text | CSRF for the Spotify leg |
| user_id | uuid nullable | filled after Spotify callback |
| our_auth_code | text nullable | issued after callback, single use |
| status | text | pending / spotify_returned / code_issued / consumed |
| created_at | timestamptz | expire after ~10 minutes |

### `mcp_tokens` (tokens we issue to Claude)
Prefer signed JWT access tokens (stateless, no lookup) with a stored refresh token. If using opaque tokens instead, store the access token hashes here too.
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid fk | |
| client_id | text | |
| refresh_token_hash | text | store hash only |
| access_token_jti | text | last issued jti for revocation |
| expires_at | timestamptz | refresh token expiry |
| revoked | boolean | |
| created_at | timestamptz | |

### `listening_snapshots` (enables taste-over-time)
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid fk | |
| captured_at | timestamptz | |
| kind | text | recently_played / top_tracks / top_artists |
| payload | jsonb | trimmed to what trends need, not full objects |

### `cache_entries`
| column | type | notes |
|---|---|---|
| cache_key | text pk | e.g. `playlist:{id}:items` |
| user_id | uuid fk | scope cache to user where relevant |
| payload | jsonb | |
| expires_at | timestamptz | TTL |

---

## 6. OAuth: the brokered flow

This is the hardest part of the project. Get it right before writing tools.

### 6.1 The two OAuth relationships

There are two separate OAuth relationships, and confusing them is the main failure mode:

1. **Claude to your server.** Your server is an OAuth 2.1 authorization server and resource server from Claude's point of view. Claude gets a bearer token from you and puts it on every MCP request.
2. **Your server to Spotify.** Your server is an OAuth client of Spotify. It holds the single owner-registered Spotify app's client id and secret and exchanges codes for per-user Spotify tokens.

Your `/authorize` endpoint is where these two meet: it receives Claude's authorization request and immediately redirects the user onward to Spotify.

### 6.2 Recommended implementation approach

The official MCP TypeScript SDK ships auth primitives, including a proxy provider designed for exactly this "delegate to an upstream authorization server" case. Start by evaluating `ProxyOAuthServerProvider` (or the current equivalent in the installed SDK version) with Spotify as the upstream. Verify it supports:

- Injecting Spotify's client id and secret on the token exchange leg.
- Mapping the returned upstream tokens to an internal user before issuing your own token to Claude.
- PKCE on the client-facing leg.

If the SDK proxy does not cleanly fit Spotify's flow, fall back to the manual implementation in 6.3, which is the underlying model the proxy automates. Record which path you took in the Decisions Log.

### 6.3 Manual flow (the fallback and the mental model)

```mermaid
sequenceDiagram
    participant U as User
    participant C as Claude
    participant S as spotify-mcp
    participant SP as Spotify

    C->>S: GET /mcp (no token)
    S-->>C: 401 + WWW-Authenticate (points to resource metadata)
    C->>S: GET /.well-known/oauth-protected-resource
    S-->>C: metadata (auth server = this server)
    C->>S: GET /.well-known/oauth-authorization-server
    S-->>C: authorize/token/register endpoints
    C->>S: POST /register (dynamic client registration)
    S-->>C: client_id (+ secret if confidential)
    C->>U: open browser to S /authorize?client_id&redirect_uri&state&code_challenge
    U->>S: GET /authorize
    S->>S: store auth_session (client params + spotify_state)
    S-->>U: 302 to Spotify /authorize (our Spotify client_id, our /callback, scopes, spotify_state)
    U->>SP: consent screen, logs in, approves
    SP-->>U: 302 to S /callback?code&state=spotify_state
    U->>S: GET /callback
    S->>SP: POST /api/token (exchange code for Spotify tokens, using our secret)
    SP-->>S: access_token + refresh_token
    S->>SP: GET /me (identify user)
    SP-->>S: spotify_user_id, display_name
    S->>S: upsert user, encrypt + store spotify_tokens, issue our_auth_code
    S-->>U: 302 back to client_redirect_uri?code=our_auth_code&state=client_state
    U->>C: browser returns code to Claude
    C->>S: POST /token (our_auth_code + PKCE verifier)
    S->>S: validate code + PKCE, issue our access token (JWT) + refresh token
    S-->>C: access_token (+ refresh_token)
    C->>S: GET/POST /mcp with Bearer our access_token
    S->>S: resolver maps token -> user; tool runs
```

### 6.4 Endpoints to implement

- `GET /.well-known/oauth-protected-resource` (RFC 9728): declares this resource and its authorization server.
- `GET /.well-known/oauth-authorization-server` (RFC 8414): advertises `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, supported PKCE methods (`S256`), grant types (`authorization_code`, `refresh_token`).
- `POST /register` (RFC 7591): dynamic client registration. Store the client and its redirect URIs. Support this because it makes the Claude connect flow smooth. Also allow a statically configured client id/secret as a fallback, since Claude's connector UI can accept a manually provided client id and secret.
- `GET /authorize`: validate `client_id` and `redirect_uri` against `mcp_clients`, persist an `auth_session` including the client's PKCE challenge and state, then 302 the user to Spotify's authorize URL with your Spotify client id, your `/callback` as redirect, the minimum scopes, and a freshly generated `spotify_state`.
- `GET /callback`: match `spotify_state` to an `auth_session`, exchange the Spotify `code` for tokens using your Spotify client secret, call `/me` to identify the user, upsert the user, encrypt and store the Spotify tokens, mint a single-use `our_auth_code`, then 302 back to the client's redirect URI with that code and the original client `state`.
- `POST /token`: handle two grant types. For `authorization_code`, validate the `our_auth_code` and the PKCE verifier against the stored challenge, then issue your own access token (JWT, short lived, ~1 hour) and a refresh token. For `refresh_token`, validate and rotate.
- Resolver middleware on `/mcp`: verify the bearer JWT, load the user, attach to the request context.

### 6.5 Spotify scopes (request the minimum)

Request only what the tools need:

```
user-read-private
user-read-recently-played
user-top-read
user-library-read
user-library-modify
playlist-read-private
playlist-modify-private
playlist-modify-public
user-read-playback-state
user-modify-playback-state
user-read-currently-playing
```

Do not request `user-read-email` unless a tool actually needs it. Fewer scopes is both a smaller consent screen and a smaller blast radius.

### 6.6 Security requirements

- PKCE (`S256`) is mandatory on the Claude-facing leg.
- `state` on both legs, validated, single use.
- `redirect_uri` allowlisting. Reject anything not registered.
- `auth_session` and `our_auth_code` expire in about 10 minutes and are single use.
- Access tokens you issue are short lived. Refresh tokens rotate on use.
- Encrypt Spotify tokens at rest with AES-256-GCM. The key comes from `MASTER_ENCRYPTION_KEY` (32 bytes, base64). Never commit it.
- Constant-time comparison for any secret or code comparison.
- Rate limit `/authorize`, `/token`, and `/register`.

---

## 7. Spotify API client

`src/spotify/client.ts` is the only place that talks to Spotify over the network. Everything else calls typed functions in `endpoints.ts`.

### 7.1 Responsibilities

- **Transparent token refresh.** Before a call, if `access_expires_at` is within a 60 second buffer, refresh using the stored refresh token, re-encrypt, and persist. On a 401 mid-call, refresh once and retry once.
- **Rate limit handling.** Spotify returns 429 with a `Retry-After` header. Respect it with a bounded backoff and a small number of retries. Surface a clean error if it persists.
- **Pagination.** As of Feb 2026, `/search` returns at most 10 items per request. Provide an internal paginating helper so higher-level tools can request more and the client walks `offset` for them, within a sane cap.
- **No dead endpoints.** The client must not expose `audio-features`, `audio-analysis`, or `recommendations`. If any tool needs mood or tempo, that is inferred elsewhere, not fetched here.
- **Typed responses.** Parse every response through a Zod schema in `types.ts`. If Spotify drops a field (they removed several in Feb 2026), the schema treats it as optional and the code handles absence gracefully.

### 7.2 Capability detection (`capabilities.ts`)

On first use per user (cache the result), determine:

- **Premium status.** Playback control requires Premium. Detect and store, so playback tools can fail fast with a helpful message instead of a raw 403.
- **Active device presence.** Checked at playback time, not cached, since it changes constantly.
- **Endpoint liveness.** For endpoints flagged volatile in Section 12, detect a removed endpoint (404 or 403 with the deprecation shape) once, cache that it is unavailable, and have dependent tools degrade rather than erroring repeatedly.

---

## 8. MCP tools

Register these on the `McpServer`. Every tool has a clear description (the model reads these to decide when to call them), Zod-validated inputs, and a structured, summarized output. Keep raw payloads out of tool outputs unless a tool is explicitly a raw fetch.

**Design principle:** shift work off the model. A tool that returns 100 raw track objects is a bad tool. A tool that returns "62 tracks, median release year 2017, top 3 artists make up 41 percent of runtime" is a good one.

### 8.1 Context and status

| Tool | Input | Returns | Notes |
|---|---|---|---|
| `get_initial_context` | none | connection status, display name, premium flag, whether an active device exists, which capabilities are available | Client should call this first. Mirrors a pattern used by existing servers so the model orients itself. |

### 8.2 Search and catalog info

| Tool | Input | Returns | Notes |
|---|---|---|---|
| `search_music` | query, types[] (track/artist/album/playlist), limit | compact list: name, primary artist, id, uri | Handles the 10-per-request cap internally by paginating up to the requested limit. |
| `get_track_details` | id | track metadata that still exists post Feb 2026 | Individual fetch; batch is gone. |
| `get_artist_details` | id | artist metadata, including genres if the field is still populated | Genres may be sparse or removed; handle absence. |
| `get_album_details` | id | album metadata and tracklist | |

### 8.3 Playlists

| Tool | Input | Returns | Notes |
|---|---|---|---|
| `list_playlists` | limit, offset | user's playlists: name, id, track count, owner | |
| `get_playlist` | id, mode (raw or summary) | either a compact track list or a summary | Uses `/playlists/{id}/items` (renamed from `/tracks`). |
| `summarize_playlist` | id | intelligence-backed summary: artist distribution, release-era spread, total runtime, dominant artists, rough genre lean | See Section 9. |
| `create_playlist` | name, description, public flag, initial track_uris[] | new playlist id and url | Verify the current create endpoint before building; a create path was flagged as changed in Feb 2026. If unavailable, degrade with a clear message. |
| `add_tracks_to_playlist` | playlist_id, track_uris[] | confirmation, new count | |
| `remove_tracks_from_playlist` | playlist_id, track_uris[] | confirmation, new count | |
| `reorder_playlist` | playlist_id, range_start, insert_before, range_length | confirmation | |

### 8.4 Playback (Premium plus active device; degrade gracefully)

| Tool | Input | Returns | Notes |
|---|---|---|---|
| `get_playback_state` | none | current track, device, shuffle/repeat, progress | |
| `control_playback` | action (play/pause/next/previous/seek/volume), args | confirmation | If no active device, return a friendly instruction to open Spotify somewhere, not a raw 404. If not Premium, say so plainly. |
| `queue_tracks` | track_uris[] | confirmation, resulting queue preview | |
| `list_devices` | none | available devices | |
| `transfer_playback` | device_id, play flag | confirmation | |

### 8.5 Library and history

| Tool | Input | Returns | Notes |
|---|---|---|---|
| `get_saved_tracks` | limit, offset | compact saved-track list | |
| `get_recently_played` | limit | compact recent plays with timestamps | Also feeds snapshots. |
| `save_items` | uris[] | confirmation | Uses the generic `PUT /me/library`. |
| `remove_items` | uris[] | confirmation | Uses `DELETE /me/library`. |

### 8.6 Insights (the differentiators)

| Tool | Input | Returns | Notes |
|---|---|---|---|
| `summarize_library` | none | aggregate stats over saved tracks: top artists, era distribution, diversity, notable concentrations | |
| `summarize_listening_trends` | window (e.g. 1m/3m/6m) | how listening has shifted using accumulated snapshots plus top-items endpoints: rising artists, fading artists, new names, concentration change over time | Requires snapshots to have been accumulating; if history is thin, say so and return what is available. |
| `find_library_gaps` | seed (artist or genre) | artists or albums adjacent to the seed that the user does not already have saved | Cross-references the model's candidate set against the user's actual library so it does not suggest things they already own. The candidate generation leans on the calling model's music knowledge; the tool's job is the library cross-reference and dedupe. |

---

## 9. Intelligence and aggregation layer

This is what separates the project from a wrapper. It lives in `src/intelligence/` and never calls Spotify directly; it consumes typed data from the Spotify client and the snapshot store.

**Hard constraint:** it must work without `audio-features`. So mood/energy claims are not asserted as data the server measured. Instead:

- **Aggregation is factual and server-computed:** counts, distributions, release-year histograms, artist concentration (for example a Herfindahl-style concentration index over artists), runtime totals, recency gaps. These are real numbers the server calculates.
- **Interpretation is deferred to the model:** the server hands Claude clean structured facts, and Claude applies musical judgment. The tool descriptions make clear which parts are measured and which are inferred.
- **Optional external grounding (post-v1):** if genre data from Spotify is too sparse, a later version may enrich via MusicBrainz or Last.fm tags. Keep this behind an interface so it is additive, not core.

### 9.1 Snapshots (`snapshots.ts`)

- On each call to `get_recently_played` and periodically via `scripts/snapshot-cron.ts`, persist a trimmed snapshot into `listening_snapshots`.
- Trends are computed by diffing snapshots across time windows. Store only what trends need (ids, artist ids, timestamps, play counts), not full objects, to keep the table small.
- If the host's free tier cannot run a scheduled job, opportunistic snapshotting on tool calls is an acceptable v1 fallback; note the tradeoff in the tool description (trends improve with use).

---

## 10. Caching and rate-limit strategy

- Cache `cache_entries` with TTLs: playlist items (short, since they change), saved tracks (short to medium), catalog info like track/artist details (longer, catalog is stable).
- Always check cache before hitting Spotify for cacheable reads.
- Because batch endpoints are gone, list-shaped operations can fan out into many single fetches. Cache aggressively and cap fan-out with a clear message when a request would exceed the cap.
- Centralize backoff so a 429 in one place does not cascade.

---

## 11. Error handling

Define typed errors in `util/errors.ts` and map them to clean MCP tool responses. Never leak a raw Spotify error body to the model.

| Condition | User-facing behavior |
|---|---|
| No active device (playback) | Explain that Spotify must be open and playing somewhere, suggest opening the app, do not error hard |
| Not Premium (playback) | State plainly that playback control needs Premium; read-only tools still work |
| Token expired | Refresh transparently and retry once; only surface an error if refresh fails |
| Refresh failed / revoked | Ask the user to reconnect the connector |
| 429 rate limited | Backoff and retry within bounds; if still limited, ask the user to try again shortly |
| Endpoint removed by Spotify | Degrade: mark capability unavailable, tell the model this feature is no longer offered by Spotify |
| Invalid tool input | Zod validation error mapped to a clear message |

---

## 12. Reference: Spotify Web API endpoint status (verify before building)

**This section is a hypothesis as of early 2026. Re-verify every item against the live docs before implementing it. Spotify has changed this repeatedly.**

**Removed or restricted for new apps (do not build on these):**
- `GET /audio-features`, `GET /audio-features` (batch), `GET /audio-analysis/{id}`: gone for new apps since Nov 2024. No official replacement.
- `GET /recommendations`: gone for new apps since Nov 2024.
- `GET /artists/{id}/top-tracks`, `GET /browse/new-releases`, `GET /markets`: removed in the Feb 2026 changes.
- Batch fetch endpoints (several albums, several artists, and similar): removed; fetch individually.
- Various fields removed from objects (popularity, followers on some types, some user fields). Treat these as optional everywhere.
- Search now returns at most 10 items per request; paginate with `offset`.
- Playlist item endpoints renamed from `/tracks` to `/items`.
- Library save/remove/follow consolidated into generic `PUT` and `DELETE /me/library` plus `GET /me/library/contains`, keyed by URIs.
- A create-playlist path was flagged as changed. Verify the current create flow explicitly.

**Believed alive (still verify):**
- `GET /search` (with the 10-item cap)
- `GET /tracks/{id}`, `GET /artists/{id}`, `GET /albums/{id}` (individual)
- `GET /me`
- `GET /me/top/{type}` (top artists/tracks; verify, this is distinct from the removed artist top-tracks)
- `GET /me/player`, `GET /me/player/currently-playing`, playback control endpoints
- `GET /me/player/recently-played`
- `GET /me/tracks` (saved tracks)
- `GET /me/playlists`, `GET /playlists/{id}`, `GET /playlists/{id}/items`
- Generic library endpoints noted above

**Operational notes:**
- Development Mode requires the app owner to hold active Premium, and caps authorized users (about 25) until you apply for Extended Quota Mode.
- Rate limiting is a rolling window with `Retry-After` on 429.

---

## 13. Environment variables

Every one of these goes in `.env.example` with a comment. The server validates them at boot via `config.ts` and exits with a clear message if any are missing or malformed.

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (host may inject this) |
| `PUBLIC_BASE_URL` | The server's public HTTPS URL, used to build redirect URIs and metadata |
| `DATABASE_URL` | Neon Postgres connection string |
| `SPOTIFY_CLIENT_ID` | Your single registered Spotify app id |
| `SPOTIFY_CLIENT_SECRET` | Your Spotify app secret |
| `SPOTIFY_REDIRECT_URI` | `${PUBLIC_BASE_URL}/callback`, also registered in the Spotify dashboard |
| `MASTER_ENCRYPTION_KEY` | 32-byte base64 key for AES-256-GCM token encryption |
| `JWT_SIGNING_KEY` | Key for signing the access tokens you issue to Claude |
| `TOKEN_ACCESS_TTL_SECONDS` | Access token lifetime (default 3600) |
| `TOKEN_REFRESH_TTL_SECONDS` | Refresh token lifetime |
| `LOG_LEVEL` | pino level |
| `NODE_ENV` | development / production |

---

## 14. Progress tracker

Update markers as you go. A phase is done only when every item is `[x]` and its acceptance criteria pass.

### Phase 0: Scaffold and tooling
- [x] Initialize repo, `package.json`, `tsconfig.json`, strict TypeScript
- [x] Add dependencies: MCP SDK, Express, Drizzle, Zod, pino, dotenv, vitest
- [x] `.gitignore` ignores `.env`, `dist`, `node_modules`
- [x] `config.ts` loads and Zod-validates all env vars, exits cleanly if invalid
- [x] `logger.ts` with secret redaction
- [x] `.env.example` with every variable documented
- [x] Health check route `GET /healthz` returns 200
- **Acceptance:** server boots, `/healthz` responds, missing env produces a clear error.

### Phase 1: Spotify client and capability verification
- [x] `spotify/types.ts` Zod schemas (fields the API still returns, everything droppable optional)
- [x] `spotify/client.ts`: fetch wrapper with refresh, single retry on 401, 429 backoff
- [x] `spotify/endpoints.ts`: typed functions only for verified-alive endpoints
- [x] `spotify/capabilities.ts`: premium detection, active-device check, endpoint-liveness cache
- [x] Verify each endpoint in Section 12 against live docs; update the Decisions Log with findings
- **Acceptance:** with a manually pasted valid token, the client can fetch `/me`, search, and read a playlist, and correctly reports premium and device status.

### Phase 2: Data layer and encryption
- [x] `db/schema.ts` for all tables in Section 5
- [~] Drizzle migrations generated and applied to Neon (generated and verified against fresh in-memory Postgres; applying to Neon happens in Phase 11 when DATABASE_URL exists)
- [x] `crypto/tokens.ts`: AES-256-GCM encrypt/decrypt with round-trip unit tests
- [x] Token read/write helpers that always encrypt at rest
- **Acceptance:** tokens round-trip through encryption; migrations apply cleanly to a fresh DB.

### Phase 3: OAuth broker
- [x] Well-known metadata endpoints (RFC 9728 and RFC 8414)
- [x] `/register` dynamic client registration, plus static client fallback (static fallback deferred, see Decisions Log 2026-07-05)
- [x] `/authorize`: validate client, persist `auth_session`, redirect to Spotify
- [x] `/callback`: exchange Spotify code, identify user, store tokens, issue our code
- [x] `/token`: authorization_code and refresh_token grants, PKCE validation, token rotation
- [x] `auth/resolver.ts`: bearer JWT to internal user middleware
- [x] PKCE, state, redirect allowlisting, expiry, rate limiting all enforced
- **Acceptance:** a full manual OAuth walk (using a tool like MCP Inspector or a scripted client) yields a working bearer token that resolves to the correct user.

### Phase 4: MCP server and transport
- [x] `mcp/server.ts` builds the `McpServer`
- [x] `mcp/transport.ts` wires Streamable HTTP into Express behind the auth resolver
- [x] Unauthenticated `/mcp` returns 401 with the correct `WWW-Authenticate`
- [x] A trivial ping tool registered and callable end to end with a bearer token
- **Acceptance:** MCP Inspector connects, authenticates, lists tools, and calls the ping tool.

### Phase 5: Core read tools
- [ ] `get_initial_context`
- [ ] `search_music` (internal pagination past the 10 cap)
- [ ] `get_track_details`, `get_artist_details`, `get_album_details`
- [ ] `list_playlists`, `get_playlist` (raw mode)
- **Acceptance:** each tool returns compact, correct data against a real account.

### Phase 6: Playback tools with graceful degradation
- [ ] `get_playback_state`, `list_devices`
- [ ] `control_playback` (play/pause/next/previous/seek/volume)
- [ ] `queue_tracks`, `transfer_playback`
- [ ] No-device and non-Premium paths return friendly guidance, not raw errors
- **Acceptance:** playback works on a Premium account with an active device; on a free account or with no device, tools respond helpfully.

### Phase 7: Library and history tools
- [ ] `get_saved_tracks`, `get_recently_played`
- [ ] `save_items`, `remove_items` via generic library endpoints
- [ ] Snapshot capture wired into recently-played reads
- **Acceptance:** saving and removing work; snapshots accumulate rows.

### Phase 8: Intelligence layer
- [ ] `summarize_playlist`
- [ ] `summarize_library`
- [ ] `summarize_listening_trends`
- [ ] `find_library_gaps`
- [ ] Clear labeling of measured vs inferred in every output
- **Acceptance:** summaries return accurate server-computed stats; trends degrade gracefully when history is thin.

### Phase 9: Caching and rate limiting
- [ ] `cache/cache.ts` with TTL reads/writes
- [ ] Cacheable reads check cache first
- [ ] Fan-out caps with clear messaging
- [ ] Centralized 429 backoff verified under simulated load
- **Acceptance:** repeated reads hit cache; a forced 429 backs off and recovers.

### Phase 10: Testing
- [ ] Unit: encryption, token refresh logic, PKCE, aggregation math
- [ ] Integration: OAuth flow with a mocked Spotify, tool calls with recorded fixtures
- [ ] Error-path tests (no device, not premium, 429, removed endpoint)
- **Acceptance:** test suite green; error paths covered.

### Phase 11: Deployment
- [ ] Deploy to Render (or Fly/Railway) with a public HTTPS URL
- [ ] Neon DB connected, migrations run on deploy
- [ ] All env vars set in the host, none in the repo
- [ ] `SPOTIFY_REDIRECT_URI` registered in the Spotify dashboard
- [ ] Health check green in production
- **Acceptance:** the production URL serves metadata and `/healthz`.

### Phase 12: Connect to Claude and validate end to end
- [ ] Add the server as a custom connector in Claude by URL
- [ ] Complete the Spotify OAuth consent
- [ ] Exercise one tool from each category from an actual Claude conversation
- **Acceptance:** a fresh user can connect and use every tool with no manual config beyond the consent screen.

### Phase 13: Docs and polish
- [ ] `README.md`: what it is, how to connect, tool list, limitations (including the dead audio-features reality)
- [ ] Note the Extended Quota Mode step for going past ~25 users
- [ ] Final pass on tool descriptions for model clarity
- **Acceptance:** a stranger can read the README and connect without asking you anything.

---

## 15. Open questions and decisions log

The agent appends here. Each entry: date, question or decision, and resolution.

- `2026-07-05` DECIDED (Section 6.2 evaluation): manual OAuth implementation per Section 6.3, not the SDK `ProxyOAuthServerProvider`. Reason: the proxy provider forwards the upstream token response to the client, meaning Claude would receive Spotify's tokens directly. Our design requires the opposite: intercept the Spotify callback, encrypt and store per-user Spotify tokens server-side, map to an internal user, and issue our own JWTs to Claude. That user-mapping and token-custody step has no clean hook in the proxy, so the manual flow is the correct fit. The SDK is still used for the MCP layer itself in Phase 4.
- `2026-07-05` Static client id/secret fallback (Section 6.4) is deferred: dynamic client registration is fully implemented and is what Claude's connector uses; a static client requires env vars not defined in Section 13. If needed later it is an additive change. Registered clients are public clients (PKCE only, `token_endpoint_auth_method: none`), which matches Claude's connector behavior.
- `2026-07-05` Phase 0 notes: local runtime is Node 24 (current LTS line) while Section 2 says Node 22 LTS; `engines` is set to `>=22` so both work, no code depends on 24-only features. Installed Zod resolved to v4, so `config.ts` uses the v4 `z.url()` API. `drizzle.config.ts` from the Section 4 tree is deferred to Phase 2 since it must reference `src/db/schema.ts`, which does not exist until then. Unit tests for config validation, log redaction, and `/healthz` were added per rule 8.
- `2026-07-05` RESOLVED: `GET /me/top/{type}` is live per current official docs. Params: `type` (artists|tracks), `time_range` (short_term|medium_term|long_term, default medium), `limit` 1-50, `offset`. Scope `user-top-read`. No deprecation notice. Usable for trends as designed.
- `2026-07-05` RESOLVED: create playlist is now `POST /me/playlists` (body: name required, public, collaborative, description). The old `POST /users/{user_id}/playlists` is removed per the Feb 2026 migration guide. `create_playlist` tool will use `POST /me/playlists`.
- `2026-07-05` Verified against the official Feb 2026 migration guide (`/documentation/web-api/tutorials/february-2026-migration-guide`): playlist item endpoints renamed to `/playlists/{id}/items` with `track` field renamed to `item` inside playlist items; search `limit` max 10 default 5; generic library endpoints confirmed as `PUT /me/library` and `DELETE /me/library` with body `{ "uris": [...] }` plus `GET /me/library/contains`; batch fetch endpoints (`GET /tracks?ids=`, `/artists?ids=`, `/albums?ids=`, etc.) removed; `GET /artists/{id}/top-tracks`, `/browse/*`, `GET /markets`, `GET /users/{id}` removed. `GET /me/tracks` (list saved) and `GET /me/player/recently-played` remain live. Playlist `items` contents are only returned for playlists the user owns or collaborates on.
- `2026-07-05` MATERIAL DOC CORRECTION: `GET /me` no longer returns `product`, `country`, `email`, `explicit_content`, or `followers` (Feb 2026 removal). Section 7.2's plan to detect Premium from `/me` cannot work. Fix: premium status starts unknown and is inferred lazily; when a playback-control call returns 403 with a premium-required reason, capabilities records `premium=false` and caches it; a successful playback-control call records `premium=true`. Playback tools phrase the unknown state honestly instead of guessing.
- `2026-07-05` Dev Mode limits per migration guide are stricter than Section 12's note: 1 client ID per developer and a 5 user cap (not ~25) until Extended Quota Mode. README must reflect this.
- `2026-07-05` Removed response fields confirmed and treated as optional in all Zod schemas: track `popularity`/`available_markets`/`external_ids`/`linked_from`; album `label`/`popularity`/`album_group`; artist `followers`/`popularity`. Artist `genres` was NOT listed as removed, so it stays in the schema as optional; actual population density gets assessed in Phase 8 against real data.
- `TODO` Confirm whether artist `genres` is still populated enough to use, or whether external genre grounding is needed sooner (assess in Phase 8 with real account data).
- `2026-07-05` Phase 4: Streamable HTTP runs in stateless mode (fresh transport and McpServer per POST, `enableJsonResponse`), the SDK's documented pattern for horizontally scalable servers; GET/DELETE `/mcp` return 405. Acceptance verified with the official SDK client (the same protocol path MCP Inspector uses) instead of the manual Inspector run: connect, list tools, call ping. Dropped `exactOptionalPropertyTypes` from tsconfig (all other strict flags stay) because the SDK's option types are incompatible with it.
- `2026-07-05` Phase 1 acceptance: unit coverage is green (refresh-on-401, bounded 429 backoff with Retry-After cap, pagination past the search cap, schema tolerance for removed fields). The live-token portion of the acceptance ("with a manually pasted valid token...") cannot run until the owner registers the Spotify app; `scripts/verify-spotify.ts` runs that exact check via `SPOTIFY_TEST_TOKEN=... npx tsx scripts/verify-spotify.ts`. Listed as a hand-off item in the final report.
- `2026-07-05` Capability cache is in-process memory for v1 (re-probes after restart) rather than `cache_entries`; acceptable because premium/liveness signals are cheap to re-learn. Swap to `cache_entries` if it matters later.
- `2026-07-05` Replaced `@neondatabase/serverless` with plain `pg` + `drizzle-orm/node-postgres`. Render runs a long-lived Node process, not an edge runtime, and Neon speaks standard Postgres with TLS, so the serverless driver adds complexity without benefit. Tests use PGlite (in-memory Postgres) to apply real migrations without a network database.

---

## 16. Future work (explicitly out of scope for v1)

- External genre or tag grounding via MusicBrainz or Last.fm.
- Redis cache if Postgres-based caching becomes a bottleneck.
- Porting the aggregation layer to Rust behind the existing interface.
- Submitting to Anthropic's connector directory once stable.
- Multi-user analytics and a lightweight web dashboard.
