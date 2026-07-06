/**
 * Phase 1 live acceptance check (spotifymcp.md Section 14).
 * Run with a manually obtained Spotify access token:
 *
 *   SPOTIFY_TEST_TOKEN=... npx tsx scripts/verify-spotify.ts [playlist_id]
 *
 * Verifies: GET /me, search, playlist read, device/premium reporting.
 * The token is read from the environment and never printed.
 */
import { SpotifyClient } from "../src/spotify/client.js";
import {
  getDevices,
  getMe,
  getMyPlaylists,
  getPlaylistItems,
  search,
} from "../src/spotify/endpoints.js";
import { createLogger } from "../src/logger.js";

const token = process.env.SPOTIFY_TEST_TOKEN;
if (!token) {
  console.error("Set SPOTIFY_TEST_TOKEN to a valid Spotify access token first.");
  process.exit(1);
}

const client = new SpotifyClient({
  tokenProvider: {
    getAccessToken: async () => token,
    refreshAccessToken: async () => {
      console.error("Token expired mid-run; paste a fresh one.");
      process.exit(1);
    },
  },
  logger: createLogger("warn"),
});

const me = await getMe(client);
console.log(`/me ok: user ${me.id} (${me.display_name ?? "no display name"})`);

const results = await search(client, "daft punk", ["track"], 15);
console.log(`search ok: ${results.tracks?.items.length ?? 0} tracks (requested 15, cap 10/req)`);

const playlists = await getMyPlaylists(client, { limit: 5 });
console.log(`playlists ok: ${playlists.items.length} returned of ${playlists.total ?? "?"}`);

const targetPlaylist = process.argv[2] ?? playlists.items[0]?.id;
if (targetPlaylist) {
  const items = await getPlaylistItems(client, targetPlaylist, { maxItems: 20 });
  console.log(`playlist read ok: ${items.tracks.length} tracks from ${targetPlaylist}`);
} else {
  console.log("playlist read skipped: no playlists on this account");
}

const devices = await getDevices(client);
const active = devices.find((d) => d.is_active);
console.log(
  `devices ok: ${devices.length} known, active: ${active ? active.name : "none"}`,
);
console.log(
  "premium: unknown until a playback call is attempted (GET /me no longer exposes product; see Decisions Log)",
);
console.log("Phase 1 live acceptance PASSED");
