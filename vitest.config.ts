import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite (in-memory Postgres WASM) takes a few seconds to boot per suite,
    // more when suites run in parallel workers.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
