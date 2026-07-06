import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite (in-memory Postgres WASM) takes a few seconds to boot per suite.
    // With ~20 suites each booting their own instance, unbounded parallel
    // workers starve each other into hook timeouts, so cap the workers; the
    // boots then overlap only a little and the suite is deterministic.
    maxWorkers: 2,
    minWorkers: 1,
    hookTimeout: 60_000,
    // A few tests boot an extra PGlite instance inside the test body, so the
    // per-test budget matches the hook budget.
    testTimeout: 60_000,
  },
});
