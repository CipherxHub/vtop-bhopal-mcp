#!/usr/bin/env tsx
/**
 * HTTP connector tests.
 *   npm run test:http
 *
 * The HTTP connector (src/http.ts) was inherited byte-for-byte and had never
 * been run — these are its first tests. They spawn the REAL built artifact
 * (dist/http.js) rather than importing the app, because what ships is what
 * should be tested: binding, middleware ordering and the tsup bundle are all
 * part of the surface.
 *
 * Every test here is OFFLINE. Nothing contacts VTOP: the server only dials out
 * lazily when a tool is called, and these only exercise routing, auth, CORS
 * and the MCP handshake. That is deliberate so the suite needs no account and
 * is safe in CI.
 *
 * The regression tests worth knowing about:
 *   - "Content-Type is application/json, not text/event-stream" guards
 *     enableJsonResponse. Without it the server works on localhost and breaks
 *     through a Cloudflare Quick Tunnel, which is a genuinely awful bug to
 *     diagnose remotely.
 *   - "CONNECTOR_SECRET + env credentials + no token -> 401" guards the auth
 *     fix. That combination used to serve /mcp to anyone with the URL.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Script } from "node:vm";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok  ${name}`);
    })
    .catch((err) => {
      console.error(`  FAIL  ${name}`);
      throw err;
    });
}

const ROOT = process.cwd();
const DIST = path.join(ROOT, "dist", "http.js");
const SECRET = "test-secret-not-a-real-deployment-key-0123456789";
const DUMMY_USER = "PLACEHOLDER_REG_NO";
const DUMMY_PASS = "PLACEHOLDER_PASSWORD";

if (!fs.existsSync(DIST)) {
  console.error(`dist/http.js is missing. Run \`npm run build\` first (test:all does).`);
  process.exit(1);
}

/**
 * Environment for a child server. The inherited VTOP_* credential variables are
 * stripped so a developer's real .env cannot make a test pass or fail.
 */
function childEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.VTOP_USERNAME;
  delete env.VTOP_PASSWORD;
  delete env.CONNECTOR_SECRET;
  delete env.REDIS_URL;
  delete env.VTOP_HTTP_BIND;
  delete env.VTOP_HTTP_CORS_ORIGIN;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

interface Running {
  proc: ChildProcessWithoutNullStreams;
  base: string;
  logs: () => string;
}

async function startServer(port: number, env: Record<string, string | undefined>): Promise<Running> {
  const proc = spawn(process.execPath, [DIST], {
    env: childEnv({ PORT: String(port), ...env }),
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  let buf = "";
  proc.stderr.on("data", (d: Buffer) => {
    buf += d.toString();
  });
  proc.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (/listening on/.test(buf)) return { proc, base, logs: () => buf };
    if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode}):\n${buf}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  proc.kill();
  throw new Error(`server did not report listening within 15s:\n${buf}`);
}

/**
 * Kill a server and WAIT for it to actually exit. Reaping asynchronously
 * matters: without awaiting, a failed assertion tears down the children while
 * Node is still exiting and libuv aborts with
 * "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" — which buries the
 * real failure message under a crash.
 */
async function stopServer(s: Running) {
  if (s.proc.exitCode !== null || s.proc.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => s.proc.once("exit", () => resolve()));
  s.proc.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  if (s.proc.exitCode === null) s.proc.kill("SIGKILL");
}

/** MCP headers. Streamable HTTP requires the client to accept both types. */
function mcpHeaders(sessionId?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) h["mcp-session-id"] = sessionId;
  return h;
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "http-test", version: "1" },
  },
};

console.log("HTTP connector (offline)");

// ---------------------------------------------------------------- lifecycle --

const legacy = await startServer(3931, { VTOP_USERNAME: DUMMY_USER, VTOP_PASSWORD: DUMMY_PASS });
const multi = await startServer(3932, { CONNECTOR_SECRET: SECRET });
const both = await startServer(3933, {
  CONNECTOR_SECRET: SECRET,
  VTOP_USERNAME: DUMMY_USER,
  VTOP_PASSWORD: DUMMY_PASS,
});

try {
  await check("healthz answers 200 for uptime pingers", async () => {
    const r = await fetch(`${legacy.base}/healthz`);
    assert.equal(r.status, 200);
    assert.equal((await r.text()).trim(), "ok");
  });

  await check("landing page, robots, sitemap and OG image all serve", async () => {
    for (const p of ["/", "/robots.txt", "/sitemap.xml", "/og.svg"]) {
      const r = await fetch(`${multi.base}${p}`);
      assert.equal(r.status, 200, `${p} returned ${r.status}`);
    }
  });

  await check("the server binds loopback by default, not every interface", async () => {
    // Reaching 127.0.0.1 proves the bind; if it were 0.0.0.0 this would also
    // pass, so assert the startup log names the loopback address instead.
    assert.match(legacy.logs(), /listening on 127\.0\.0\.1:/);
  });

  // -------------------------------------------------------------------- auth --

  await check("tokenless GET /mcp is refused", async () => {
    const r = await fetch(`${multi.base}/mcp`, { headers: mcpHeaders() });
    assert.equal(r.status, 401);
  });

  await check("tokenless POST /mcp initialize is refused (what a connector sends)", async () => {
    const r = await fetch(`${multi.base}/mcp`, {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify(INIT),
    });
    assert.equal(r.status, 401);
  });

  await check(
    "REGRESSION: CONNECTOR_SECRET + env credentials + no token is still refused",
    async () => {
      // This is the case that used to be silently open. The documented setup is
      // a .env with credentials, so anyone who also set CONNECTOR_SECRET got a
      // server that served /mcp to whoever held the URL.
      for (const method of ["GET", "POST"] as const) {
        const r = await fetch(`${both.base}/mcp`, {
          method,
          headers: mcpHeaders(),
          ...(method === "POST" ? { body: JSON.stringify(INIT) } : {}),
        });
        assert.equal(r.status, 401, `${method} returned ${r.status}, expected 401`);
      }
    },
  );

  await check("single-user mode (no CONNECTOR_SECRET) still allows a tokenless call", async () => {
    const r = await fetch(`${legacy.base}/mcp`, {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify(INIT),
    });
    assert.equal(r.status, 200, "legacy single-user path must not regress");
  });

  await check("a garbage token is refused rather than treated as anonymous", async () => {
    const r = await fetch(`${multi.base}/mcp/not-a-real-token`, {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify(INIT),
    });
    assert.equal(r.status, 401);
  });

  await check("/register is unavailable without CONNECTOR_SECRET", async () => {
    const r = await fetch(`${legacy.base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: DUMMY_USER, password: DUMMY_PASS }),
    });
    assert.equal(r.status, 503);
  });

  // ------------------------------------------------------------------- CORS --

  await check("an Origin header gets no Access-Control-Allow-Origin by default", async () => {
    const r = await fetch(`${multi.base}/healthz`, { headers: { Origin: "https://evil.example" } });
    assert.equal(r.status, 200);
    assert.equal(
      r.headers.get("access-control-allow-origin"),
      null,
      "CORS must be opt-in; reflecting arbitrary origins lets any site call this server",
    );
  });

  // ------------------------------------------------------------ MCP protocol --

  let sessionId = "";
  await check("initialize without a token is refused before content negotiation", async () => {
    const r = await fetch(`${multi.base}/mcp`, {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify(INIT),
    });
    assert.equal(r.status, 401, "no token yet — authenticate first");
  });

  // Authenticate with a token minted through /register, exactly as a user does.
  const token = await (async () => {
    const r = await fetch(`${multi.base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: DUMMY_USER, password: DUMMY_PASS }),
    });
    assert.equal(r.status, 200);
    const html = await r.text();
    // The token is echoed in the page so the user can copy it; pull it from the
    // connector URL the page renders.
    const m = html.match(/\/mcp\/([A-Za-z0-9_-]{40,})/);
    assert.ok(m, "register page did not render a connector link with a token");
    return m[1];
  })();

  await check("a token from /register authenticates the MCP endpoint", async () => {
    const r = await fetch(`${multi.base}/mcp/${token}`, {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify(INIT),
    });
    assert.equal(r.status, 200);
    const ct = r.headers.get("content-type") ?? "";
    assert.match(ct, /application\/json/, `expected JSON, got ${ct}`);
    assert.doesNotMatch(
      ct,
      /text\/event-stream/,
      "enableJsonResponse regressed — this breaks Cloudflare Quick Tunnels",
    );
    sessionId = r.headers.get("mcp-session-id") ?? "";
    assert.ok(sessionId, "no mcp-session-id header on initialize");
  });

  await check("tools/list exposes all 41 tools with correct write hints", async () => {
    await fetch(`${multi.base}/mcp/${token}`, {
      method: "POST",
      headers: mcpHeaders(sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    const r = await fetch(`${multi.base}/mcp/${token}`, {
      method: "POST",
      headers: mcpHeaders(sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] };
    };
    const tools = body.result.tools;
    assert.equal(tools.length, 41, `expected 41 tools, got ${tools.length}`);

    const nonReadOnly = tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name);
    // Five, not one. apply_leave submits a real leave application and
    // cancel_leave withdraws one. get_captcha,
    // login and logout all mutate server-side session state (arming the prelogin
    // session, establishing it, clearing it), so none of them is read-only even
    // though none of them touches a grade.
    assert.deepEqual(
      nonReadOnly.sort(),
      ["apply_leave", "cancel_leave", "get_captcha", "login", "logout"],
      "readOnlyHint:false must mark exactly the state-changing tools",
    );

    // The distinction that actually matters: apply_leave is a real write to
    // VTOP, but it is not *destructive* — nothing is deleted.
    const leave = tools.find((t) => t.name === "apply_leave");
    assert.equal(leave?.annotations?.readOnlyHint, false, "apply_leave must prompt");
    assert.equal(
      leave?.annotations?.destructiveHint,
      false,
      "apply_leave is additive, so destructiveHint must stay false",
    );
  });

  // ------------------------------------------------------------ landing page --

  await check("landing page is client-neutral, not ChatGPT-only", async () => {
    const html = await (await fetch(`${multi.base}/`)).text();
    assert.doesNotMatch(html, /now in <em>ChatGPT<\/em>/, "the hero reverted to a single client");
    for (const client of ["Claude (web, desktop app", "ChatGPT", "Cursor, Windsurf", "Claude Code"]) {
      assert.ok(html.includes(client), `landing page no longer mentions ${client}`);
    }
  });

  await check("landing page does not advertise an npm package that does not exist", async () => {
    // The package is private and was never published, so an install line here
    // would 404 for every student who tried it.
    const html = await (await fetch(`${multi.base}/`)).text();
    assert.doesNotMatch(html, /npm install vtop-bhopal-mcp/);
    assert.ok(html.includes("git clone"), "landing page should show the clone instructions instead");
  });

  await check("landing nav anchors stay reachable on mobile", async () => {
    // Hiding nav links under 560px stranded small-screen users mid-page;
    // the bar scrolls horizontally instead.
    const html = await (await fetch(`${multi.base}/`)).text();
    for (const a of ['href="#how"', 'href="#connect"', 'href="#safe"']) {
      assert.ok(html.includes(a), `landing page lost anchor ${a}`);
    }
    assert.doesNotMatch(html, /a:not\(\.madeby\)\{display:none\}/, "nav links must not be hidden on small screens");
  });

  await check("inline page script parses and masks on input", async () => {
    // The script runs on every page: a syntax error kills copy/show/connect.
    // Masking must run on keystrokes (input), not just field focus (click).
    const html = await (await fetch(`${multi.base}/`)).text();
    const js = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1];
    assert.ok(js, "landing page should carry its inline script");
    assert.doesNotThrow(() => new Script(js), "inline script must parse");
    assert.ok(html.includes('addEventListener("input"'), "reg-number masking must run on input events");
    assert.ok(html.includes('addEventListener("submit"'), "double-submit guard must be wired");
  });

  await check("register form is password-manager and keyboard friendly", async () => {
    const html = await (await fetch(`${multi.base}/`)).text();
    assert.ok(html.includes('autocomplete="username"'), "username field should invite the password manager");
    assert.ok(html.includes('autocomplete="current-password"'), "password field should invite the password manager");
    assert.ok(html.includes('pattern="[0-9]{2}[A-Z]{3}[0-9]{5}"'), "strict reg-number shape pinned");
    assert.ok(html.includes(":focus-visible"), "keyboard focus must be visible");
  });

  await check("faint text meets AA contrast in both themes", async () => {
    // #8c897e on paper was 3.19:1; #6f6d65 on near-black 3.77:1. Both fail
    // small text, so the values below are pinned, not incidental.
    const html = await (await fetch(`${multi.base}/`)).text();
    assert.ok(html.includes("--faint:#6f6c62"), "light faint text must stay at 4.78:1");
    assert.ok(html.includes("--faint:#8f8c83"), "dark faint text must stay at 5.82:1");
  });

  await check("og image is client-neutral like the page", async () => {
    const svg = await (await fetch(`${multi.base}/og.svg`)).text();
    assert.ok(svg.includes("any assistant"), "og image must match the client-neutral hero");
    assert.doesNotMatch(svg, /ChatGPT/, "og image must not single out one client");
  });
  await check("hamburger menu exists with honest expanded state", async () => {
    // On a phone the link row does not fit: links collapse behind a menu
    // button instead of vanishing. Closed = display:none, so hidden links
    // stay out of the tab order without extra work.
    const html = await (await fetch(`${multi.base}/`)).text();
    assert.ok(html.includes('data-menu'), "menu button must be in the header");
    assert.ok(html.includes('aria-controls="sitenav"'), "button must point at the nav it toggles");
    assert.ok(html.includes('id="sitenav"'), "nav must carry the toggled id");
    assert.ok(html.includes('aria-expanded="false"'), "menu must start collapsed");
    assert.ok(html.includes('header.open nav'), "collapsed nav must have an open state in CSS");
    assert.ok(html.includes('"Escape"'), "Escape must close the menu");
  });

  await check("anchored sections clear the sticky header", async () => {
    // Menu navigation jumps to #how/#connect/#safe; without scroll-margin
    // the sticky bar covers the section kicker on arrival.
    const html = await (await fetch(`${multi.base}/`)).text();
    assert.ok(html.includes("section[id]{scroll-margin-top:"), "anchors must offset the sticky header");
    assert.ok(html.includes("overflow-x:clip"), "100vw header backdrop must not cause sideways scroll");
  });

  await check("register never echoes the submitted password back", async () => {
    const html = await (
      await fetch(`${multi.base}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: DUMMY_USER, password: DUMMY_PASS }),
      })
    ).text();
    assert.doesNotMatch(html, new RegExp(DUMMY_PASS), "the password must not appear in the response");
    assert.match(html, /\/mcp\/[A-Za-z0-9_-]{40,}/, "the connector link should be on the page");
  });

  await check("the page carrying the token is noindex and not cacheable", async () => {
    const r = await fetch(`${multi.base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: DUMMY_USER, password: DUMMY_PASS }),
    });
    const html = await r.text();
    assert.match(html, /noindex/, "the token page must not be indexed");
    assert.equal(r.headers.get("cache-control"), "no-store");
  });

  await check("the username field enforces the registration-number shape", async () => {
    const html = await (await fetch(`${multi.base}/`)).text();
    const input = html.match(/<input id="username"[^>]*>/)?.[0] ?? "";
    assert.ok(input, "username field not found");
    // Backstop for browsers with scripting disabled: the browser refuses a
    // bad shape on submit rather than letting a typo reach VTOP.
    assert.match(input, /pattern="\[0-9\]\{2\}\[A-Z\]\{3\}\[0-9\]\{5\}"/);
    assert.match(input, /maxlength="10"/);
    // Live filtering is the primary guard; these two are what makes it usable
    // on a phone keyboard.
    assert.match(input, /autocapitalize="characters"/);
    assert.match(input, /spellcheck="false"/);
    // The in-page handler that drops a character typed in the wrong slot.
    assert.ok(
      html.includes('e.target.id==="username"'),
      "the positional input filter is missing from the page",
    );
    // The removed hint line must stay gone.
    assert.doesNotMatch(html, /Two digits for the batch/);
  });

  await check(
    "a session id cannot be replayed under a different token (issue #5)",
    async () => {
      // The transport is bound to sha256(token) and compared with
      // timingSafeEqual. Knowing a session id must not be enough to drive it -
      // otherwise one user can impersonate another by obtaining the id, and
      // Mcp-Session-Id is a response header a browser client can read.
      const other = await (
        await fetch(`${multi.base}/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: DUMMY_USER + "_B", password: DUMMY_PASS }),
        })
      ).text();
      const otherToken = other.match(/\/mcp\/([A-Za-z0-9_-]{40,})/)?.[1];
      assert.ok(otherToken, "could not mint a second token");
      assert.notEqual(otherToken, token, "the two tokens must differ");

      const r = await fetch(`${multi.base}/mcp/${otherToken}`, {
        method: "POST",
        headers: mcpHeaders(sessionId), // victim's session id, attacker's token
        body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }),
      });
      assert.equal(
        r.status,
        400,
        "a session id replayed under another token must be refused",
      );
    },
  );

  // --------------------------------------------------------------- logging --

  await check("the connector token never appears in the server's own logs", async () => {
    const logs = multi.logs();
    assert.doesNotMatch(logs, new RegExp(token), "token leaked into stdout/stderr");
    assert.doesNotMatch(logs, /\/mcp\/[A-Za-z0-9_-]{40,}/, "a full connector path leaked into logs");
    // The route must still be visible for operators: redacted, not dropped.
    assert.match(logs, /\/mcp\/\[redacted\]/, "token-in-URL requests log a redacted route");
  });

  console.log(`\n${passed} checks passed.`);
} finally {
  await Promise.all([stopServer(legacy), stopServer(multi), stopServer(both)]);
}
