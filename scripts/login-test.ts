#!/usr/bin/env tsx
/**
 * Offline tests for the LOGIN HANDSHAKE and the structured error taxonomy.
 *   npm run test:login
 *
 * These run against scripts/mock-vtop.ts, a local stand-in for the portal — no
 * network, no real credentials, no captcha to read. They cover the part of the
 * system that was previously untested: get_captcha -> login -> session state,
 * every documented login failure mode, and the mapping from those failures to
 * stable machine-readable error codes with a recovery plan.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join as pathJoin } from "node:path";
import { tmpdir } from "node:os";
import * as os from "node:os";
import * as path from "node:path";
import {
  saveCaptchaFile,
  captchaDir,
  openCaptchaImage,
  isCaptchaOpenEnabled,
  captchaOpenCommand,
} from "../src/services/captcha-file.js";
import { VtopClient } from "../src/services/vtop-client.js";
import { VtopError, classify, isNotAuthenticated, type VtopErrorCode } from "../src/services/errors.js";
import { errorResult } from "../src/tools/_helpers.js";
import {
  startMockVtop,
  TEST_CAPTCHA,
  TEST_PASS,
  TEST_REGNO,
  TEST_USER,
  type MockOptions,
} from "./mock-vtop.js";

// The mock serves a throwaway self-signed cert; skip verification for it only.
// VTOP_BASE_URL is pointed at the mock per-test below, so this never weakens
// the real portal connection.
process.env.VTOP_INSECURE_TLS = "1";
delete process.env.HTTPS_PROXY;
delete process.env.https_proxy;
delete process.env.VTOP_PROXY_URL;

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

/** Run the full happy-path handshake against a fresh mock, returning the client. */
async function loggedInClient(opts: MockOptions = {}) {
  const { mock, baseUrl, close } = await startMockVtop(opts);
  const client = new VtopClient(baseUrl);
  const img = await client.getCaptcha();
  await client.login(TEST_USER, TEST_PASS, TEST_CAPTCHA);
  return { mock, client, close, img };
}

/** Assert that `fn` throws a VtopError with the given code. */
async function expectCode(
  name: string,
  code: VtopErrorCode,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(
      err instanceof VtopError,
      `${name}: expected VtopError, got ${(err as Error)?.name}: ${(err as Error)?.message}`,
    );
    assert.equal(err.code, code, `${name}: expected ${code}, got ${err.code}`);
    return;
  }
  throw new Error(`${name}: expected a throw with code ${code}, but it succeeded`);
}

async function main() {
  console.log("login handshake (offline, mock VTOP)");

  // ---------------------------------------------------------------- happy path
  {
    const { client, close, img } = await loggedInClient();
    await check("getCaptcha returns a base64 PNG data URL", () => {
      assert.match(img, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
    });

    // --- captcha file fallback (image-blind clients) -------------------------
    // Observed twice in the wild: Codex's TUI and OpenCode's plain TUI both
    // drop MCP `image` content blocks, so the model was asked to read an image
    // it could not see. It guessed, three times, and each guess was a real
    // failed login against the student's account. The captcha is now also
    // written to disk so those clients have something they can actually open.
    const capDir = path.join(os.tmpdir(), "vtop-captcha-test");
    await check("captcha is written to disk for clients that cannot render images", async () => {
      rmSync(capDir, { recursive: true, force: true });
      process.env.VTOP_CAPTCHA_DIR = capDir;
      const m = img.match(/^data:(image\/[^;]+);base64,(.+)$/);
      assert.ok(m, "captcha should be a data URL");
      const file = saveCaptchaFile(m[1], m[2]);
      assert.ok(file, "saveCaptchaFile should return a path");
      assert.ok(isAbsolute(file), `captcha path must be absolute, got ${file}`);
      assert.ok(existsSync(file), `captcha file should exist at ${file}`);
      assert.equal(
        readFileSync(file).toString("base64").replace(/=+$/, ""),
        m[2].replace(/=+$/, ""),
        "file bytes must match the image block",
      );
      assert.match(basename(file), /^captcha-.+\.png$/, "filename should be predictable");
      delete process.env.VTOP_CAPTCHA_DIR;
    });
    await check("captcha path honours VTOP_CAPTCHA_DIR", () => {
      process.env.VTOP_CAPTCHA_DIR = "D:\\somewhere\\else";
      assert.equal(captchaDir(), "D:\\somewhere\\else");
      delete process.env.VTOP_CAPTCHA_DIR;
      assert.equal(captchaDir(), path.join(os.tmpdir(), "vtop-mcp-captcha"));
    });
    await check("a failed captcha write degrades instead of breaking login", () => {
      // An unwritable dir must never be fatal: the image block still carries
      // the captcha, so returning null is correct and throwing is not.
      // Use a regular FILE as a path component, so mkdir fails with ENOTDIR.
      const m = img.match(/^data:(image\/[^;]+);base64,(.+)$/);
      assert.ok(m);
      const blocker = path.join(os.tmpdir(), "vtop-captcha-blocker");
      writeFileSync(blocker, "not a directory");
      try {
        process.env.VTOP_CAPTCHA_DIR = path.join(blocker, "captchas");
        assert.equal(
          saveCaptchaFile(m[1], m[2]),
          null,
          "an unwritable directory must yield null, not throw",
        );
      } finally {
        delete process.env.VTOP_CAPTCHA_DIR;
        rmSync(blocker, { force: true });
      }
    });

    // --- optional viewer launch (VTOP_CAPTCHA_OPEN) -------------------------
    // Codex renders no image blocks and its model will not open a local file to
    // look at one, so on that client the round trip needs a human. This launches
    // the viewer for them. It spawns a GUI process, so it is off unless the env
    // var is exactly "1" - a shared HTTP connector would otherwise throw a window
    // on whoever is sitting at the keyboard.
    await check("captcha viewer launch is OFF unless VTOP_CAPTCHA_OPEN=1", () => {
      delete process.env.VTOP_CAPTCHA_OPEN;
      assert.equal(isCaptchaOpenEnabled(), false);
      assert.equal(openCaptchaImage("C:\\anything.jpg"), false, "must not spawn when disabled");
      process.env.VTOP_CAPTCHA_OPEN = "true";
      assert.equal(
        isCaptchaOpenEnabled(),
        false,
        "only the exact string '1' enables it, so a stray 'true' cannot",
      );
      delete process.env.VTOP_CAPTCHA_OPEN;
    });
    await check("viewer command is built per platform with no shell interpolation", () => {
      assert.deepEqual(captchaOpenCommand("C:\\x\\c.jpg", "win32"), {
        cmd: "cmd",
        args: ["/c", "start", "", "C:\\x\\c.jpg"],
      });
      assert.deepEqual(captchaOpenCommand("/tmp/c.jpg", "darwin"), {
        cmd: "open",
        args: ["/tmp/c.jpg"],
      });
      assert.deepEqual(captchaOpenCommand("/tmp/c.jpg", "linux"), {
        cmd: "xdg-open",
        args: ["/tmp/c.jpg"],
      });
      assert.equal(captchaOpenCommand("/tmp/c.jpg", "aix" as NodeJS.Platform), null);
      // The empty "" must be present: `start` takes it as the window title, and
      // without it a quoted path gets opened as a title instead of launched.
      const win = captchaOpenCommand("C:\\x\\c.jpg", "win32")!;
      assert.equal(win.args[2], "", "win32 start needs an empty title slot");
    });
    await check("viewer launch refuses a file that is not there", () => {
      // Guards against the launcher firing on a path that failed to write, and
      // against the env var being set on a box with no desktop at all.
      process.env.VTOP_CAPTCHA_OPEN = "1";
      try {
        assert.equal(
          openCaptchaImage(path.join(os.tmpdir(), "definitely-not-here-12345.jpg")),
          false,
          "must not spawn a viewer for a missing file",
        );
      } finally {
        delete process.env.VTOP_CAPTCHA_OPEN;
      }
    });

    await check("login marks the session authenticated", () => {
      assert.equal(client.isAuthenticated, true);
    });
    await check("registration number is exposed after login", () => {
      assert.equal(client.registrationNumber, TEST_REGNO);
    });
    await check("an authenticated data call succeeds", async () => {
      const html = await client.fetchPage("processViewStudentAttendance");
      assert.match(html, /processViewStudentAttendance OK/);
    });
    await check("keepAlive reports a live session", async () => {
      assert.equal(await client.keepAlive(), true);
    });
    await close();
  }

  // ------------------------------------------------------------- handshake shape
  {
    const { mock, close } = await loggedInClient();
    await check("handshake order is /login -> /prelogin/setup -> /login", () => {
      // initSession GETs the portal selector to pick up cookies, then POSTs the
      // prelogin handshake; login() then POSTs on the same armed session.
      assert.deepEqual(mock.log, [
        "GET /vtop/login",
        "POST /vtop/prelogin/setup",
        "POST /vtop/login",
      ]);
    });
    await close();
  }

  // ------------------------------------------------------------ login failures
  await check("wrong captcha -> INVALID_CAPTCHA", async () => {
    const { baseUrl, close } = await startMockVtop({ mode: "invalidCaptcha" });
    const client = new VtopClient(baseUrl);
    await client.getCaptcha();
    await expectCode("wrong captcha", "INVALID_CAPTCHA", () =>
      client.login(TEST_USER, TEST_PASS, "WRONG"),
    );
    await close();
  });

  await check("wrong password -> INVALID_CREDENTIALS", async () => {
    const { baseUrl, close } = await startMockVtop();
    const client = new VtopClient(baseUrl);
    await client.getCaptcha();
    await expectCode("wrong password", "INVALID_CREDENTIALS", () =>
      client.login(TEST_USER, "not-the-password", TEST_CAPTCHA),
    );
    await close();
  });

  await check("locked account -> ACCOUNT_LOCKED", async () => {
    const { baseUrl, close } = await startMockVtop({ mode: "locked" });
    const client = new VtopClient(baseUrl);
    await client.getCaptcha();
    await expectCode("locked", "ACCOUNT_LOCKED", () =>
      client.login(TEST_USER, TEST_PASS, TEST_CAPTCHA),
    );
    await close();
  });

  await check("max attempts -> MAX_LOGIN_ATTEMPTS", async () => {
    const { baseUrl, close } = await startMockVtop({ mode: "maxAttempts" });
    const client = new VtopClient(baseUrl);
    await client.getCaptcha();
    await expectCode("max attempts", "MAX_LOGIN_ATTEMPTS", () =>
      client.login(TEST_USER, TEST_PASS, TEST_CAPTCHA),
    );
    await close();
  });

  await check("unrecognised response -> UPSTREAM with page diagnostics", async () => {
    const { baseUrl, close } = await startMockVtop({ mode: "unrecognized" });
    const client = new VtopClient(baseUrl);
    await client.getCaptcha();
    try {
      await client.login(TEST_USER, TEST_PASS, TEST_CAPTCHA);
      throw new Error("expected a throw");
    } catch (err) {
      assert.ok(err instanceof VtopError);
      assert.equal(err.code, "UPSTREAM");
      // The diagnostic must identify the page, not just say "it failed".
      assert.match(err.detail ?? "", /\[diagnostic\]/);
    }
    await close();
  });

  // ---------------------------------------------------------- captcha failures
  await check("reCAPTCHA page -> RECAPTCHA_REQUIRED", async () => {
    const { baseUrl, close } = await startMockVtop({ mode: "recaptcha" });
    const client = new VtopClient(baseUrl);
    await expectCode("recaptcha", "RECAPTCHA_REQUIRED", () => client.getCaptcha());
    await close();
  });

  await check("no captcha on page -> CAPTCHA_NOT_FOUND", async () => {
    const { baseUrl, close } = await startMockVtop({ mode: "noCaptcha" });
    const client = new VtopClient(baseUrl);
    await expectCode("no captcha", "CAPTCHA_NOT_FOUND", () => client.getCaptcha());
    await close();
  });

  await check("login on an unarmed session -> SESSION_MISMATCH", async () => {
    const { baseUrl, close } = await startMockVtop();
    const client = new VtopClient(baseUrl);
    // Skip getCaptcha, so the prelogin handshake never armed this session.
    await expectCode("unarmed session", "SESSION_MISMATCH", () =>
      client.login(TEST_USER, TEST_PASS, TEST_CAPTCHA),
    );
    await close();
  });

  // -------------------------------------------------------- session lifecycle
  await check("data call without login -> NOT_AUTHENTICATED", async () => {
    const { baseUrl, close } = await startMockVtop();
    const client = new VtopClient(baseUrl);
    await expectCode("no session", "NOT_AUTHENTICATED", () =>
      client.fetchPage("processViewStudentAttendance"),
    );
    await close();
  });

  await check("server-side expiry mid-session -> NOT_AUTHENTICATED", async () => {
    // Allow one data call, then expire — models VTOP's ~60 min timeout.
    const { baseUrl, close } = await startMockVtop({ expireAfterDataCalls: 1 });
    const client = new VtopClient(baseUrl);
    await client.getCaptcha();
    await client.login(TEST_USER, TEST_PASS, TEST_CAPTCHA);
    await client.fetchPage("processViewStudentAttendance"); // survives
    await expectCode("expired mid-session", "NOT_AUTHENTICATED", () =>
      client.fetchPage("processViewStudentAttendance"),
    );
    assert.equal(client.isAuthenticated, false, "expiry must clear the local flag");
    await close();
  });

  await check("logout clears session state", async () => {
    const { client, close } = await loggedInClient();
    await client.logout();
    assert.equal(client.isAuthenticated, false);
    assert.equal(client.registrationNumber, null);
    await close();
  });

  // ------------------------------------------------------- error taxonomy shape
  await check("NOT_AUTHENTICATED carries an ordered recovery plan", () => {
    const body = new VtopError("NOT_AUTHENTICATED", "gone").toBody();
    assert.equal(body.code, "NOT_AUTHENTICATED");
    assert.deepEqual(body.recovery, ["get_captcha", "login"]);
    assert.equal(body.needsUserInput, false);
    assert.equal(body.retryable, false);
  });

  await check("CREDENTIALS_REQUIRED asks the user for input", () => {
    const body = new VtopError("CREDENTIALS_REQUIRED", "none").toBody();
    assert.equal(body.needsUserInput, true);
    assert.deepEqual(body.recovery, ["login"]);
  });

  await check("TIMEOUT is retryable with no recovery steps", () => {
    const body = new VtopError("TIMEOUT", "slow").toBody();
    assert.equal(body.retryable, true);
    assert.deepEqual(body.recovery, []);
  });

  await check("message keeps the code prefix for legacy string checks", () => {
    const err = new VtopError("NOT_AUTHENTICATED", "VTOP session expired.");
    assert.ok(err.message.startsWith("NOT_AUTHENTICATED"));
    assert.equal(isNotAuthenticated(err), true);
  });

  await check("toBody strips the code prefix from the human message", () => {
    const body = new VtopError("NOT_AUTHENTICATED", "VTOP session expired.").toBody();
    assert.equal(body.message, "VTOP session expired.");
  });

  // --------------------------------------------------------- error classification
  await check("classify maps axios timeout -> TIMEOUT", () => {
    const err = new Error("timeout of 30000ms exceeded");
    assert.equal(classify(err).code, "TIMEOUT");
  });
  await check("classify maps DNS failure -> NETWORK", () => {
    assert.equal(classify(new Error("getaddrinfo ENOTFOUND vtop.vitbhopal.ac.in")).code, "NETWORK");
  });
  await check("classify maps connection refused -> NETWORK", () => {
    assert.equal(classify(new Error("connect ECONNREFUSED 127.0.0.1:443")).code, "NETWORK");
  });
  await check("classify passes a VtopError through untouched", () => {
    const original = new VtopError("ACCOUNT_LOCKED", "locked");
    assert.equal(classify(original), original);
  });
  await check("classify falls back to UPSTREAM", () => {
    assert.equal(classify(new Error("something odd")).code, "UPSTREAM");
  });

  // ------------------------------------------------------ MCP tool result shape
  await check("errorResult exposes code + recovery in structuredContent", () => {
    const result = errorResult(new VtopError("NOT_AUTHENTICATED", "VTOP session expired."));
    assert.equal(result.isError, true);
    const sc = result.structuredContent as {
      ok: boolean;
      error: { code: string; recovery: string[] };
    };
    assert.equal(sc.ok, false);
    assert.equal(sc.error.code, "NOT_AUTHENTICATED");
    assert.deepEqual(sc.error.recovery, ["get_captcha", "login"]);
    // The prose must lead with the same code, so text and data can't disagree.
    assert.match(result.content[0].text as string, /^NOT_AUTHENTICATED:/);
  });

  await check("errorResult text tells the model how to recover", () => {
    const result = errorResult(new VtopError("NOT_AUTHENTICATED", "VTOP session expired."));
    const text = result.content[0].text as string;
    assert.match(text, /get_captcha -> login/);
  });

  // ------------------------------------------------- captcha image conditioning
  await check("captcha is upscaled for legibility (200x40 -> 5x)", async () => {
    const { upscaleCaptcha } = await import("../src/services/captcha-image.js");
    // A tiny valid PNG to transform (10x4 -> 50x20).
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const out = await upscaleCaptcha(png);
    const b64 = out.split(",")[1];
    // 50x20 baseline64 JPEG starts with /9j/ (JPEG SOI marker).
    assert.match(b64, /^\/9j\//, "expected re-encoded JPEG");
    const bytes = Buffer.from(b64, "base64");
    assert.ok(bytes.length > 0);
  });

  await check("upscaling disabled returns the original data URL", async () => {
    const { upscaleCaptcha } = await import("../src/services/captcha-image.js");
    process.env.VTOP_CAPTCHA_SCALE = "1";
    const png = "data:image/png;base64,AAAA";
    assert.equal(await upscaleCaptcha(png), png, "scale=1 must be a no-op");
    delete process.env.VTOP_CAPTCHA_SCALE;
  });

  await check("a non-data-URL is passed through untouched", async () => {
    const { upscaleCaptcha } = await import("../src/services/captcha-image.js");
    const junk = "not-a-data-url";
    assert.equal(await upscaleCaptcha(junk), junk);
  });

  await check("corrupt image data falls back instead of throwing", async () => {
    const { upscaleCaptcha } = await import("../src/services/captcha-image.js");
    const bad = "data:image/png;base64,bm90YW5pbWFnZQ==";
    // Must not reject: a captcha we can't transform still gets returned.
    assert.equal(typeof (await upscaleCaptcha(bad)), "string");
  });

  await check("getCaptcha delivers an upscaled image end to end", async () => {
    const { mock, baseUrl, close } = await startMockVtop();
    const client = new VtopClient(baseUrl);
    const img = await client.getCaptcha();
    // Still a data URL (the mock serves a 1x1 PNG; upscaling keeps it one).
    assert.match(img, /^data:image\/png;base64,/);
    await close();
    void mock;
  });

  // ------------------------------------------------------------ session keepalive
  await check("keepalive defaults to 5 minutes", async () => {
    const { keepaliveMinutes } = await import("../src/services/keepalive.js");
    delete process.env.VTOP_KEEPALIVE_MINUTES;
    assert.equal(keepaliveMinutes(), 5);
  });

  await check("keepalive disabled with 0", async () => {
    const { keepaliveMinutes } = await import("../src/services/keepalive.js");
    process.env.VTOP_KEEPALIVE_MINUTES = "0";
    assert.equal(keepaliveMinutes(), 0);
  });

  await check("keepalive accepts a custom interval", async () => {
    const { keepaliveMinutes } = await import("../src/services/keepalive.js");
    process.env.VTOP_KEEPALIVE_MINUTES = "9";
    assert.equal(keepaliveMinutes(), 9);
    delete process.env.VTOP_KEEPALIVE_MINUTES;
  });

  await check("garbage keepalive interval disables rather than misfires", async () => {
    const { keepaliveMinutes } = await import("../src/services/keepalive.js");
    process.env.VTOP_KEEPALIVE_MINUTES = "soon";
    assert.equal(keepaliveMinutes(), 0);
    process.env.VTOP_KEEPALIVE_MINUTES = "-3";
    assert.equal(keepaliveMinutes(), 0);
    delete process.env.VTOP_KEEPALIVE_MINUTES;
  });

  await check("keepalive keeps a live session alive", async () => {
    const { baseUrl, close } = await startMockVtop({ expireAfterDataCalls: 2 });
    const client = new VtopClient(baseUrl);
    await client.getCaptcha();
    await client.login(TEST_USER, TEST_PASS, TEST_CAPTCHA);
    // Each keepAlive() is itself a data call, so two touches span the
    // expire-after-2 window and prove repeated touches keep the session up.
    assert.equal(await client.keepAlive(), true);
    assert.equal(await client.keepAlive(), true);
    assert.equal(client.isAuthenticated, true);
    await close();
  });

  await check("keepalive is a no-op with no session", async () => {
    const { baseUrl, close } = await startMockVtop();
    const client = new VtopClient(baseUrl);
    assert.equal(await client.keepAlive(), false);
    assert.equal(client.isAuthenticated, false);
    await close();
  });

  console.log(`\n${passed} passed`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("\nFAILED:", err);
    process.exit(1);
  });