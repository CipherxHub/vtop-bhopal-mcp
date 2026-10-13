#!/usr/bin/env tsx
/**
 * Offline tests for server-side session persistence (no Redis, no network):
 *   - crypto encryptString/decryptString round-trip
 *   - VtopClient.exportSession / importSession round-trip (cookies + identity)
 *   - getSessionStore() is null when REDIS_URL is unset
 *   npm run test:session
 */
import assert from "node:assert/strict";

// Persistence blobs are encrypted with CONNECTOR_SECRET — set one before the
// crypto module reads it.
process.env.CONNECTOR_SECRET = "test-connector-secret-0123456789";
delete process.env.REDIS_URL;

const { encryptString, decryptString } = await import("../src/services/crypto.js");
const { VtopClient } = await import("../src/services/vtop-client.js");
const { getSessionStore } = await import("../src/services/session-store.js");
const { statsPage } = await import("../src/web.js");
const { CookieJar } = await import("tough-cookie");

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ok  ${name}`); };

// --- crypto round-trip ---
check("encryptString/decryptString round-trips", () => {
  const secret = JSON.stringify({ a: 1, b: "héllo", c: [true, null] });
  const token = encryptString(secret);
  assert.notEqual(token, secret);
  assert.equal(decryptString(token), secret);
});
check("decryptString rejects a tampered token", () => {
  const token = encryptString("payload");
  const tampered = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");
  assert.throws(() => decryptString(tampered));
});

// --- VtopClient session round-trip ---
check("exportSession/importSession preserves cookies + identity", () => {
  // Build a session as if we'd logged in: a JSESSIONID cookie + auth identity.
  const jar = new CookieJar();
  jar.setCookieSync("JSESSIONID=abc123; Path=/", "https://vtopcc.vit.ac.in/vtop");
  const session = {
    cookies: jar.serializeSync(),
    authorizedID: "21BCE1234",
    csrf: "csrf-token-xyz",
  };

  const restored = new VtopClient();
  assert.equal(restored.isAuthenticated, false);
  restored.importSession(session);
  assert.equal(restored.isAuthenticated, true); // authorizedID present → authed

  const out = restored.exportSession();
  assert.equal(out.authorizedID, "21BCE1234");
  assert.equal(out.csrf, "csrf-token-xyz");
  const cookies = (out.cookies as { cookies: { key: string; value: string }[] }).cookies;
  assert.ok(
    cookies.some((c) => c.key === "JSESSIONID" && c.value === "abc123"),
    "JSESSIONID cookie should survive the round-trip",
  );
});
check("importSession tolerates a corrupt blob (stays unauthenticated)", () => {
  const c = new VtopClient();
  // A non-JSON string makes CookieJar.deserializeSync throw → import bails out
  // and leaves the client unauthenticated (next call re-logins).
  c.importSession({ cookies: "}{ not valid json", authorizedID: "x", csrf: "y" });
  assert.equal(c.isAuthenticated, false);
});

// --- store factory ---
check("getSessionStore() is null without REDIS_URL", () => {
  assert.equal(getSessionStore(), null);
});

// --- stats dashboard rendering ---
check("statsPage renders count, reg number, logins + reuses (noindex)", () => {
  const html = statsPage([
    { regNo: "23BCE1851", firstSeen: "2026-05-24T10:00:00Z", lastSeen: "2026-05-24T14:00:00Z", logins: 7, reuses: 12 },
  ]);
  assert.match(html, /class="big">1</); // 1 unique user
  assert.match(html, /23BCE1851/);
  assert.match(html, /class="n">7</); // login count
  assert.match(html, /class="n">12</); // reuse count
  assert.match(html, /session reuses/); // summary line
  assert.match(html, /noindex/); // not crawlable
});
check("statsPage handles no users", () => {
  assert.match(statsPage([]), /No activity recorded/);
});

console.log(`\n${passed} checks passed.`);
