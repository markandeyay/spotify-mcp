import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db.js";
import { createDbCache, type Cache } from "../../src/cache/cache.js";
import type { Db } from "../../src/db/client.js";

/** Phase 9: TTL cache semantics against the real cache_entries table. */

describe("db cache", () => {
  let db: Db;
  let close: () => Promise<void>;
  let clock: Date;
  let cache: Cache;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    clock = new Date("2026-07-06T12:00:00Z");
    cache = createDbCache(db, () => clock);
  });

  afterAll(async () => {
    await close();
  });

  it("round-trips a value within its TTL", async () => {
    await cache.set("k1", { hello: "world" }, 60);
    expect(await cache.get("k1")).toEqual({ hello: "world" });
  });

  it("returns undefined once the TTL has passed", async () => {
    await cache.set("k2", "short-lived", 30);
    clock = new Date(clock.getTime() + 31_000);
    expect(await cache.get("k2")).toBeUndefined();
  });

  it("overwrites an existing key instead of failing on conflict", async () => {
    await cache.set("k3", "first", 60);
    await cache.set("k3", "second", 60);
    expect(await cache.get("k3")).toBe("second");
  });

  it("delete invalidates immediately", async () => {
    await cache.set("k4", "cached", 3600);
    await cache.delete("k4");
    expect(await cache.get("k4")).toBeUndefined();
  });

  it("sweep removes only expired rows", async () => {
    await cache.set("fresh", 1, 3600);
    await cache.set("stale", 2, 10);
    clock = new Date(clock.getTime() + 60_000);
    await cache.sweep();
    expect(await cache.get("fresh")).toBe(1);
    expect(await cache.get("stale")).toBeUndefined();
  });
});
