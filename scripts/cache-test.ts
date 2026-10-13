#!/usr/bin/env tsx
/**
 * Offline tests for the TTL cache used by live VTOP pages.
 *   npm run test:cache
 *
 * A fake clock drives expiry so the TTL behaviour is tested without waiting.
 */
import assert from "node:assert/strict";
import { TtlCache, liveCacheTtlMs } from "../src/services/cache.js";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok  ${name}`);
    })
    .catch((err: unknown) => {
      console.error(`  FAIL  ${name}`);
      throw err;
    });
}

async function main() {
  console.log("live-page TTL cache (offline)");

  let now = 1_000;
  const clock = () => now;
  const cache = new TtlCache<string>(60_000, clock);

  await check("misses an unknown key", () => {
    assert.equal(cache.get("nope"), undefined);
  });

  await check("serves a fresh value without reloading", async () => {
    let calls = 0;
    const load = async () => {
      calls++;
      return "page";
    };
    assert.equal(await cache.fetch("a", load), "page");
    assert.equal(await cache.fetch("a", load), "page");
    assert.equal(calls, 1, "second call must come from cache");
  });

  await check("refetches once the TTL expires", async () => {
    let calls = 0;
    const load = async () => `v${++calls}`;
    assert.equal(await cache.fetch("k", load), "v1");
    now += 59_000;
    assert.equal(await cache.fetch("k", load), "v1", "still fresh at 59s");
    now += 2_000; // now 61s: expired
    assert.equal(await cache.fetch("k", load), "v2", "refetched after TTL");
  });

  await check("concurrent callers share ONE request", async () => {
    // Without in-flight de-duplication, asking several things at once would
    // still fire one request each — which is the case being optimised.
    const c = new TtlCache<string>(60_000, clock);
    let calls = 0;
    const load = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return "shared";
    };
    const results = await Promise.all([
      c.fetch("x", load),
      c.fetch("x", load),
      c.fetch("x", load),
    ]);
    assert.deepEqual(results, ["shared", "shared", "shared"]);
    assert.equal(calls, 1, "three concurrent calls -> one VTOP request");
  });

  await check("a rejected load is not cached", async () => {
    const c = new TtlCache<string>(60_000, clock);
    let attempts = 0;
    const flaky = async () => {
      attempts++;
      if (attempts === 1) throw new Error("network");
      return "ok";
    };
    await assert.rejects(() => c.fetch("f", flaky), /network/);
    assert.equal(await c.fetch("f", flaky), "ok", "retried after failure");
    assert.equal(attempts, 2);
  });

  await check("clear() empties everything", async () => {
    let calls = 0;
    const load = async () => `v${++calls}`;
    await cache.fetch("c", load);
    cache.clear();
    assert.equal(cache.get("c"), undefined);
    await cache.fetch("c", load);
    assert.equal(calls, 2);
  });

  await check("default TTL is 60s, 0 disables", () => {
    delete process.env.VTOP_LIVE_CACHE_MS;
    assert.equal(liveCacheTtlMs(), 60_000);
    process.env.VTOP_LIVE_CACHE_MS = "0";
    assert.equal(liveCacheTtlMs(), 0);
    process.env.VTOP_LIVE_CACHE_MS = "5000";
    assert.equal(liveCacheTtlMs(), 5000);
    process.env.VTOP_LIVE_CACHE_MS = "nonsense";
    assert.equal(liveCacheTtlMs(), 60_000, "garbage falls back to the default");
    process.env.VTOP_LIVE_CACHE_MS = "-1";
    assert.equal(liveCacheTtlMs(), 0, "negative disables rather than misbehaving");
    delete process.env.VTOP_LIVE_CACHE_MS;
  });

  console.log(`\n${passed} passed`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("\nFAILED:", err);
    process.exit(1);
  });