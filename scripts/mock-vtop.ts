/**
 * A minimal, offline stand-in for the VTOP portal.
 *
 * It reproduces just enough of VTOP's real request flow to exercise the login
 * handshake end to end without touching the network:
 *
 *   GET  /vtop/login              → portal selector page, mints JSESSIONID
 *   POST /vtop/prelogin/setup     → student login page carrying the captcha
 *   POST /vtop/login              → authorizedIDX on success, error text otherwise
 *   POST /vtop/<any endpoint>     → authenticated data (or an expired-session page)
 *
 * The failure modes mirror the ones the real portal produces, so tests can
 * assert that each one maps to the right VtopError code.
 */

import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

/** A real 1×1 PNG — the client only regex-matches the data URL, but keeping it
 *  a genuine image means the mock behaves like the portal for image sniffing. */
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const TEST_REGNO = "22BCE1234";
export const TEST_USER = "22bce1234";
export const TEST_PASS = "s3cret-password";
/** The captcha text the mock expects on a successful login. */
export const TEST_CAPTCHA = "A7B2C";

export type MockMode =
  /** Everything works. */
  | "ok"
  /** Login page carries no captcha image at all. */
  | "noCaptcha"
  /** Login page serves Google reCAPTCHA instead of the image. */
  | "recaptcha"
  /** Captcha is rejected. */
  | "invalidCaptcha"
  /** Username/password rejected. */
  | "invalidCreds"
  | "locked"
  | "maxAttempts"
  /** Login returns 200 but no authorizedIDX and no recognised error. */
  | "unrecognized";

export interface MockOptions {
  mode?: MockMode;
  /**
   * After this many authenticated data calls, start behaving like a dead
   * session (returns an "not authorized" page) — models VTOP's ~60 min timeout.
   */
  expireAfterDataCalls?: number;
  /**
   * Serve over HTTPS (default). VtopClient wires its cookie jar through an
   * https.Agent, so plain HTTP never sends JSESSIONID back and the login
   * handshake cannot be exercised faithfully without TLS.
   */
  tls?: boolean;
}

interface Session {
  /** prelogin/setup was called for this session (the captcha belongs to it). */
  armed: boolean;
  authenticated: boolean;
  dataCalls: number;
}

export class MockVtop {
  mode: MockMode;
  expireAfterDataCalls: number | null;
  /** Requests seen, so tests can assert on the handshake itself. */
  readonly log: string[] = [];
  private sessions = new Map<string, Session>();
  private nextId = 1;

  constructor(opts: MockOptions = {}) {
    this.mode = opts.mode ?? "ok";
    this.expireAfterDataCalls = opts.expireAfterDataCalls ?? null;
  }

  /** Force a brand-new session, so the next login POST is a session mismatch. */
  resetSession(): void {
    this.sessions.clear();
  }

  private sessionFor(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) {
      s = { armed: false, authenticated: false, dataCalls: 0 };
      this.sessions.set(id, s);
    }
    return s;
  }

  handle = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void => {
    const url = req.url ?? "/";
    const path = url.split("?")[0];
    this.log.push(`${req.method} ${path}`);

    // Session cookie (VTOP keeps everything in JSESSIONID).
    const cookieHeader = req.headers.cookie ?? "";
    const match = /(?:^|;\s*)JSESSIONID=([^;]+)/.exec(cookieHeader);
    let sid = match?.[1];
    const setCookie: string[] = [];
    if (!sid) {
      sid = `sess-${this.nextId++}`;
      setCookie.push(`JSESSIONID=${sid}; Path=/; HttpOnly`);
    }
    const session = this.sessionFor(sid);

    const body = this.readBody(req).then((raw) =>
      this.route(
        path,
        req.method ?? "GET",
        new URLSearchParams(raw),
        session,
        res,
        setCookie,
      ),
    );
    body.catch((err: unknown) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(err));
    });
  };

  private async readBody(req: http.IncomingMessage): Promise<string> {
    if (req.method === "GET" || req.method === "HEAD") return "";
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  private send(
    res: http.ServerResponse,
    html: string,
    status = 200,
    setCookie: string[] = [],
  ): void {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      ...(setCookie.length ? { "Set-Cookie": setCookie } : {}),
    });
    res.end(html);
  }

  private route(
    path: string,
    method: string,
    form: URLSearchParams,
    session: Session,
    res: http.ServerResponse,
    setCookie: string[] = [],
  ): void {
    // --- portal selector: mints the session cookie, no captcha here ---
    if (path === "/vtop/login" && method === "GET") {
      this.send(res, this.page("VTOP Login", csrfHtml()), 200, setCookie);
      return;
    }

    // --- prelogin handshake: arms the session and returns the captcha page ---
    if (path === "/vtop/prelogin/setup" && method === "POST") {
      session.armed = true;
      session.authenticated = false;
      this.send(res, this.loginPageHtml(), 200, setCookie);
      return;
    }

    // --- the actual login POST ---
    if (path === "/vtop/login" && method === "POST") {
      // VTOP 404s when the captcha belongs to a different session than the
      // POST — the caller must fetch a brand-new captcha.
      if (!session.armed) {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("<html><body>Not Found</body></html>");
        return;
      }

      const captcha = form.get("captchaStr") ?? "";
      const username = form.get("username") ?? "";
      const password = form.get("password") ?? "";

      // A reCAPTCHA/no-captcha login page never armed a usable captcha; VTOP
      // rejects whatever the client guessed.
      if (this.mode === "invalidCaptcha" || captcha !== TEST_CAPTCHA) {
        session.authenticated = false;
        this.send(res, this.page("Login", `<div class="err">Invalid Captcha</div>`), 200, setCookie);
        return;
      }
      if (this.mode === "invalidCreds" || username !== TEST_USER || password !== TEST_PASS) {
        session.authenticated = false;
        this.send(
          res,
          this.page("Login", `<div class="err">Invalid User Name / Password</div>`),
          200,
          setCookie,
        );
        return;
      }
      if (this.mode === "locked") {
        session.authenticated = false;
        this.send(res, this.page("Login", `<div class="err">Account is Locked</div>`), 200, setCookie);
        return;
      }
      if (this.mode === "maxAttempts") {
        session.authenticated = false;
        this.send(
          res,
          this.page("Login", `<div class="err">Maximum Fail Attempts Reached</div>`),
          200,
          setCookie,
        );
        return;
      }
      if (this.mode === "unrecognized") {
        session.authenticated = false;
        this.send(res, this.page("Login", `<div>something unexpected</div>`), 200, setCookie);
        return;
      }

      session.authenticated = true;
      this.send(
        res,
        this.page(
          "Home",
          `<input type="hidden" id="authorizedIDX" value="${TEST_REGNO}">${csrfHtml()}<div>Welcome</div>`,
        ),
        200,
        setCookie,
      );
      return;
    }

    // --- authenticated endpoints ---
    if (path.startsWith("/vtop/")) {
      if (path === "/vtop/processLogout") {
        session.authenticated = false;
        this.send(res, this.page("Bye", `<div>logged out</div>`), 200, setCookie);
        return;
      }
      if (!session.authenticated || !form.get("authorizedID")) {
        this.send(res, this.page("Login", csrfHtml()), 200, setCookie);
        return;
      }
      session.dataCalls += 1;
      if (
        this.expireAfterDataCalls !== null &&
        session.dataCalls > this.expireAfterDataCalls
      ) {
        // VTOP signals a dead session on a data page; postWithAuth looks for
        // these markers to decide the session expired.
        session.authenticated = false;
        this.send(
          res,
          this.page("Login", `<div class="err">Not Authorized</div>`),
          200,
          setCookie,
        );
        return;
      }
      this.send(res, this.page("Data", `<div>${path} OK</div>`), 200, setCookie);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("<html><body>Not Found</body></html>");
  }

  private page(title: string, body: string): string {
    return `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;
  }

  private loginPageHtml(): string {
    const csrf = csrfHtml();
    if (this.mode === "recaptcha") {
      return this.page(
        "Login",
        `${csrf}<form action="login"><input type="hidden" name="captchaStr">
         <div class="g-recaptcha" data-sitekey="6LcTESTKEY"></div>
         <input type="hidden" name="g-recaptcha-response"></form>`,
      );
    }
    if (this.mode === "noCaptcha") {
      return this.page("Login", `${csrf}<form action="login"><input name="username"></form>`);
    }
    return this.page(
      "Login",
      `${csrf}<form action="login">
        <div id="captchaBlock"><img id="captchaImg" src="data:image/png;base64,${PNG_1x1}" alt="captcha"></div>
        <input name="captchaStr"><input name="username"><input name="password" type="password">
      </form>`,
    );
  }
}

function csrfHtml(): string {
  return `<input type="hidden" name="_csrf" content="csrf-token-value">`;
}

/**
 * A throwaway self-signed cert for 127.0.0.1, generated once per test run into
 * the OS temp dir and cached in-process. Nothing is written into the repo — a
 * committed test key would trip every secret scanner.
 */
let tlsMaterial: { key: Buffer; cert: Buffer } | null = null;

function opensslPath(): string | null {
  const candidates = [
    "openssl",
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
    "C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe",
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ["version"], { stdio: "ignore" });
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

function ensureTlsMaterial(): { key: Buffer; cert: Buffer } {
  if (tlsMaterial) return tlsMaterial;
  const bin = opensslPath();
  if (!bin) {
    throw new Error(
      "openssl not found — the mock VTOP needs TLS (VtopClient carries its cookie " +
        "jar on an https.Agent). Install OpenSSL or put it on PATH, then re-run.",
    );
  }
  const dir = path.join(os.tmpdir(), "vtop-mcp-mock-tls");
  fs.mkdirSync(dir, { recursive: true });
  const keyFile = path.join(dir, "key.pem");
  const certFile = path.join(dir, "cert.pem");
  execFileSync(
    bin,
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyFile, "-out", certFile,
      "-days", "1", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  tlsMaterial = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  return tlsMaterial;
}

/** Start the mock on an ephemeral port. Returns its `/vtop` base URL. */
export async function startMockVtop(
  opts: MockOptions = {},
): Promise<{ mock: MockVtop; baseUrl: string; close: () => Promise<void> }> {
  const mock = new MockVtop(opts);
  const useTls = opts.tls !== false;
  const server = useTls
    ? https.createServer(ensureTlsMaterial(), mock.handle)
    : http.createServer(mock.handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    mock,
    baseUrl: `${useTls ? "https" : "http"}://127.0.0.1:${port}/vtop`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}