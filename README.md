# spotify-mcp

A remote MCP server for Spotify with brokered OAuth and a server-side intelligence layer. Add it to Claude as a custom connector, log in to Spotify once, and every tool works. No local install, no JSON editing, no per-user Spotify developer app.

## Use the hosted server

1. In Claude, go to Settings, then Connectors, then "Add custom connector".
2. Paste this URL:

   ```
   https://spotify-mcp-u1c9.onrender.com/mcp
   ```

3. Claude opens a Spotify login page. Approve it.
4. Ask Claude to call `get_initial_context` to confirm the connection.

You authenticate once. The server encrypts your Spotify tokens at rest and refreshes them transparently.

Note: the Spotify app behind the hosted server runs in Development Mode, which Spotify caps at 5 authorized users. Your Spotify account email must be allowlisted by the owner before you can log in. If you are not on the list, self-host instead.

## Self-hosting

You need: a [Spotify developer app](https://developer.spotify.com/dashboard), a free [Neon](https://neon.tech) Postgres database, and a free [Render](https://render.com) web service (Fly.io or Railway work too).

1. **Spotify dashboard:** create an app. Add `https://<your-host>/callback` as a redirect URI. Note the client ID and secret. The app owner needs active Premium for the playback tools, and each user's Spotify email must be added under User Management while in Development Mode (5 max).
2. **Neon:** create a project and copy the connection string.
3. **Render:** create a web service from this repo.
   - Build command: `npm ci --include=dev && npm run build && npm run db:migrate` (the `--include=dev` matters: Render sets `NODE_ENV=production`, which otherwise skips the dev dependencies the build needs; migrations run against `DATABASE_URL` on each deploy and are idempotent)
   - Start command: `npm start`
   - Health check path: `/healthz`
4. **Environment variables:** set every variable from [`.env.example`](.env.example) in the Render dashboard. Nothing sensitive lives in the repo; the server validates the environment at boot and exits with a specific message if anything is missing or malformed. Generate `MASTER_ENCRYPTION_KEY` with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and use a long random string for `JWT_SIGNING_KEY`. `SPOTIFY_REDIRECT_URI` must be exactly `<PUBLIC_BASE_URL>/callback` and must match the redirect URI registered in the Spotify dashboard character for character. If `MASTER_ENCRYPTION_KEY` ever changes, all stored tokens become undecryptable and every user must reconnect.
5. Verify `https://<your-host>/healthz` returns 200 and `https://<your-host>/.well-known/oauth-authorization-server` returns metadata, then connect from Claude as above. The connector URL is `https://<your-host>/mcp`; the `/mcp` path is required.

## Development

```
npm install
npm run dev          # tsx watch with a local .env
npm test             # full suite: unit + integration against in-memory Postgres
npm run typecheck
```

Tests need no network or credentials. The full system design, tool reference, and decisions log live in [`spotifymcp.md`](spotifymcp.md).
