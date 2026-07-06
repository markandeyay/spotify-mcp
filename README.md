# spotify-mcp

A remote, hosted MCP server for Spotify with brokered OAuth and a server-side intelligence layer. Add it to Claude as a custom connector by pasting one URL, log in to Spotify once, and every tool works: no local install, no JSON editing, no per-user Spotify developer app.

## What makes it different

Most open-source Spotify MCP servers are thin wrappers around playback, search, and playlist CRUD. This one adds three things:

1. **An intelligence layer.** Tools return pre-aggregated summaries (playlist composition, library statistics, listening trends, library gap analysis) instead of dumping raw JSON into the model's context window. The numbers are computed on the server; interpretation is explicitly left to the model, and every output labels which is which.
2. **Statefulness over time.** The server snapshots listening history as you use it, so it can answer questions Spotify's API cannot answer in a single call, such as which artists are rising or fading in your rotation over months.
3. **Honesty about the current API.** Spotify removed the audio-features, audio-analysis, and recommendations endpoints for third-party apps in November 2024, and removed more (artist top-tracks, browse, batch fetches, several response fields) in February 2026. This server does not pretend otherwise: nothing depends on dead endpoints, removed fields are optional everywhere, and if Spotify drops an endpoint at runtime the affected tool degrades with a clear message instead of erroring repeatedly.

## Connecting from Claude

1. In Claude, go to Settings, then Connectors, then "Add custom connector".
2. Paste the server URL (for example `https://your-app.onrender.com/mcp`).
3. Claude discovers the OAuth endpoints, registers itself, and opens a Spotify login page. Approve it.
4. That's it. Ask Claude to call `get_initial_context` to confirm the connection.

You authenticate once. The server encrypts your Spotify tokens at rest (AES-256-GCM) and refreshes them transparently; you only see the consent screen again if Spotify revokes the grant.

**Development Mode note:** until the Spotify app behind this server is granted Extended Quota Mode, Spotify caps it at 5 authorized users, and the app owner must add each user's Spotify account email in the developer dashboard under User Management. Apply for Extended Quota Mode from the app dashboard to lift this.

## Tools

### Orientation
| Tool | What it does |
|---|---|
| `get_initial_context` | Call first. Connection status, display name, premium status, active device, available capabilities. |

### Search and catalog
| Tool | What it does |
|---|---|
| `search_music` | Search tracks, artists, albums, playlists. Paginates internally past Spotify's 10-per-request cap, up to 50 per type. |
| `get_track_details` | Metadata for one track (cached). |
| `get_artist_details` | Metadata for one artist; says so plainly when Spotify omits genres. |
| `get_album_details` | Album metadata and tracklist. |

### Playlists
| Tool | What it does |
|---|---|
| `list_playlists` | Your playlists with track counts and owners. |
| `get_playlist` | One playlist, `raw` (compact track list) or `summary` (server-computed aggregates). |
| `create_playlist` | New playlist (private by default), optionally with initial tracks. |
| `add_tracks_to_playlist` / `remove_tracks_from_playlist` / `reorder_playlist` | Playlist mutations; each invalidates the relevant cache. |

### Playback (requires Premium and an active device)
| Tool | What it does |
|---|---|
| `get_playback_state` | Current track, device, shuffle/repeat, progress. |
| `control_playback` | Play, pause, next, previous, seek, volume. |
| `queue_tracks` | Queue tracks in order. |
| `list_devices` | Available Spotify Connect devices. |
| `transfer_playback` | Move playback to another device. |

With no active device you get an instruction to open Spotify somewhere, not a raw error. On a free account you get a plain statement that playback control needs Premium; every read-only tool still works.

### Library and history
| Tool | What it does |
|---|---|
| `get_saved_tracks` | Saved (liked) tracks, newest first. |
| `get_recently_played` | Recent plays with timestamps. Each call also feeds the trend snapshots. |
| `save_items` / `remove_items` | Save or remove tracks, albums, or artist follows by URI. |

### Insights (the differentiators)
| Tool | What it does |
|---|---|
| `summarize_playlist` | Artist distribution and concentration, release-era spread, runtime, add-date range. Measured, not vibes. |
| `summarize_library` | Aggregates over saved tracks: top artists, era distribution, diversity, save cadence by year. |
| `summarize_listening_trends` | Rising, fading, and new artists plus concentration change, from accumulated snapshots and Spotify's short-term vs long-term rankings. Honest when history is still thin. |
| `find_library_gaps` | The model proposes candidate artists/albums; the server measures which are genuinely absent from your library so it never recommends something you already have. |

## Limitations

- **No audio features, no recommendations.** Spotify removed these endpoints for third-party apps (November 2024). Mood or energy characterizations in conversation are the model's inference from artists and eras, and the tools say so; they are not measured data.
- **Playback control needs Spotify Premium and an active device.** Spotify also no longer tells apps the subscription level, so premium status reads as "not yet determined" until the first playback attempt reveals it.
- **Playlist contents are only returned for playlists you own or collaborate on** (February 2026 API change).
- **Search returns at most 10 results per request** on Spotify's side; the server paginates internally up to 50 per type.
- **Trend quality grows with use.** Listening snapshots accumulate as the connector is used; `summarize_listening_trends` says explicitly when stored history is too thin and falls back to Spotify's own top-item rankings.
- **Large libraries are scanned up to the 500 most recent saves** per analysis call to bound API fan-out; outputs disclose when this truncates.

## Self-hosting

You need: a [Spotify developer app](https://developer.spotify.com/dashboard), a free [Neon](https://neon.tech) Postgres database, and a free [Render](https://render.com) web service (Fly.io or Railway work too).

1. **Spotify dashboard:** create an app. Add `https://<your-host>/callback` as a redirect URI. Note the client ID and secret. The app owner needs active Premium for Development Mode.
2. **Neon:** create a project and copy the connection string.
3. **Render:** create a web service from this repo.
   - Build command: `npm ci && npm run build && npm run db:migrate` (migrations run against `DATABASE_URL` on each deploy; they are idempotent).
   - Start command: `npm start`
   - Health check path: `/healthz`
4. **Environment variables:** set every variable from [`.env.example`](.env.example) in the Render dashboard. Nothing sensitive lives in the repo; the server validates the environment at boot and exits with a specific message if anything is missing or malformed. Generate `MASTER_ENCRYPTION_KEY` with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and use a long random string for `JWT_SIGNING_KEY`.
5. Verify `https://<your-host>/healthz` returns 200 and `https://<your-host>/.well-known/oauth-authorization-server` returns metadata, then connect from Claude as above.

## Development

```
npm install
npm run dev          # tsx watch with a local .env
npm test             # full suite: unit + integration against in-memory Postgres
npm run typecheck
```

Integration tests run against PGlite (real migrations, in-memory Postgres) and a fake Spotify, so no network or credentials are needed.

The full system design, phase-by-phase build plan, and decisions log live in [`spotifymcp.md`](spotifymcp.md).
