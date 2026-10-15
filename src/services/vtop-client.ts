import https from "node:https";
import axios, { AxiosInstance } from "axios";
import { CookieJar } from "tough-cookie";
import { HttpsProxyAgent } from "https-proxy-agent";
import { createCookieAgent } from "http-cookie-agent/http";
import {
  COURSE_CODE_PATTERN,
  ENDPOINTS,
  LEAVE_CONTROL,
  LEAVE_FORM_NAME,
  LEAVE_TYPE_CONTROL,
} from "./constants.js";
import { VtopError, isNotAuthenticated, classify } from "./errors.js";
import { upscaleCaptcha, describeCaptchaSize } from "./captcha-image.js";
import { TtlCache, liveCacheTtlMs } from "./cache.js";
import { applySystemCATrust, isTruthy, vtopCaBundle } from "./tls.js";
import {
  parseCalendarMonths,
  parseAcademicCalendar,
  hasAttendanceDetailTable,
  parseLeaveCancelControls,
  calDateMonthKey,
} from "./vtop-parser.js";
import type { CalendarDay } from "./attendance-calc.js";
import { pMap } from "./concurrency.js";

const DEFAULT_BASE_URL = "https://vtop.vitbhopal.ac.in/vtop";

/**
 * A serializable snapshot of an authenticated VTOP session — the cookie jar
 * (JSESSIONID etc.) plus the auth identity. Persisted (encrypted) so a fresh
 * process can resume without re-running the captcha+login.
 */
export interface VtopSession {
  /** tough-cookie SerializedCookieJar, or null if the jar was empty. */
  cookies: unknown;
  authorizedID: string | null;
  csrf: string | null;
}

// An https-proxy agent that also reads/writes the cookie jar at the socket
// level. axios-cookiejar-support's wrapper() refuses a foreign http(s).Agent,
// so when proxying we hand cookie handling to this composed agent instead.
const HttpsProxyCookieAgent = createCookieAgent(HttpsProxyAgent);
// Direct (no-proxy) cookie agent — same socket-level cookie handling as the
// proxy agent, so we can give it a custom CA bundle (VTOP's missing intermediate)
// while keeping verification on. Replaces axios-cookiejar-support's wrapper().
const HttpsCookieAgent = createCookieAgent(https.Agent);

/**
 * Resolve a proxy URL from the environment, or undefined for a direct
 * connection. VTOP serves a Google reCAPTCHA (which this server can't read)
 * instead of the OCR-able image captcha when its risk score is high, and a
 * datacenter/cloud egress IP (e.g. a PaaS host) reliably trips that. Routing
 * VTOP traffic through a residential/mobile proxy lowers the score so the image
 * variant is served. VTOP_PROXY_URL scopes the proxy to VTOP only; HTTPS_PROXY
 * is honored as a fallback.
 */
function resolveProxyUrl(): string | undefined {
  return (
    process.env.VTOP_PROXY_URL ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    undefined
  );
}

const AUTH_ID_RE =
  /id="authorizedIDX"\s+value="([^"]+)"|value="([^"]+)"\s+id="authorizedIDX"/;

const CSRF_RE =
  /name="_csrf"\s+(?:content|value)="([^"]+)"|value="([^"]+)"\s+name="_csrf"/;

/**
 * Maximum semesters to probe when auto-detecting the active term. VIT runs
 * Fall / Winter / Summer; the active term is always one of the three most
 * recent dropdown entries. Bounds worst-case latency on first data call to
 * ~3 × one round-trip.
 */
const MAX_PROBE_SEMESTERS = 3;

/**
 * When the captcha image isn't found, summarize what VTOP actually returned so
 * the failure is diagnosable from the client (e.g. a reCAPTCHA variant, a WAF /
 * region block, or a genuine markup change) without dumping the whole page.
 */
function describeLoginPage(html: string): string {
  const lower = html.toLowerCase();
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim().slice(0, 90);
  const markers: string[] = [];
  // A real sitekey means reCAPTCHA is actually rendered; the bare hidden
  // g-recaptcha-response field is just dormant template markup, present even
  // when the normal image captcha is shown.
  if (/data-sitekey="[^"]+"/i.test(html)) markers.push("reCAPTCHA-active");
  else if (/g-recaptcha-response/i.test(lower)) markers.push("recaptcha-field-dormant");
  if (/hcaptcha/.test(lower)) markers.push("hCaptcha");
  if (/cloudflare|cf-ray|attention required|cf-chl/.test(lower)) markers.push("cloudflare/WAF");
  if (/access denied|forbidden|not authorized|blocked|unusual traffic|region/.test(lower))
    markers.push("block-text");
  if (lower.includes("captchablock")) markers.push("captchaBlock");
  if (lower.includes("captchastr")) markers.push("captchaStr-field");
  if (/<form[^>]+action="[^"]*login/i.test(lower)) markers.push("login-form");
  const imgCount = (html.match(/<img/gi) ?? []).length;
  const hasDataImg = /<img[^>]+src="data:image/i.test(html);
  return (
    `[diagnostic] htmlLen=${html.length} title="${title}" imgs=${imgCount} ` +
    `dataImg=${hasDataImg} markers=[${markers.join(",") || "none"}]`
  );
}

export class VtopClient {
  // All session state and caches below are PER-INSTANCE (one VtopClient per
  // user — see http.ts client-pool). They must never be made static/module-level,
  // or one user's data would leak to another. Node is single-threaded so these
  // fields aren't subject to data races across concurrent requests.
  // Two axios instances over ONE shared cookie jar. Strategy: ALWAYS go direct
  // (fast) and only use the proxy when VTOP serves the unreadable reCAPTCHA on
  // the login page — i.e. the proxy is a reCAPTCHA fallback for login, never the
  // default path. Authenticated data requests always go direct (VTOP doesn't
  // bind the session to the IP — verified empirically), so they stay fast even
  // when a login had to use the proxy. `proxyClient` is null when no proxy is
  // configured. `VTOP_PROXY_ALL=1` forces everything through the proxy.
  private directClient!: AxiosInstance;
  private proxyClient: AxiosInstance | null = null;
  /** Which client armed the current prelogin session, so login() submits on the same one. */
  private armedViaProxy = false;
  /** VTOP_PROXY_ALL: route data (and login) through the proxy unconditionally. */
  private readonly proxyAll = /^(1|true|yes|on)$/i.test(process.env.VTOP_PROXY_ALL ?? "");
  private jar: CookieJar;
  private baseUrl: string;
  private authenticated = false;
  private csrfToken: string | null = null;
  private authorizedID: string | null = null;
  /**
   * Consecutive INVALID_CREDENTIALS rejections. A model that ignores the
   * do-not-retry guidance could otherwise loop get_captcha -> login with the
   * same wrong password until VTOP locks the account server-side. Past the
   * cap the client refuses locally. Reset on any successful login.
   */
  private consecutiveBadCreds = 0;

  /**
   * Fired after the session changes in a way worth persisting (successful login,
   * keepalive touch). Set by the HTTP layer to write the session to the store;
   * a no-op for stdio / when persistence is disabled. Fire-and-forget.
   */
  onSessionPersist?: () => void;
  /** Fired when the session is gone (logout) and any persisted copy should drop. */
  onSessionClear?: () => void;
  /**
   * Fired once on a successful login with the VTOP authorizedID (the student's
   * registration number). Used by the HTTP layer to record usage stats. Should
   * be fire-and-forget so it never delays login.
   */
  onLogin?: (regNo: string) => void;
  private cachedActiveSemesterId: string | null = null;
  private cachedGradeHistoryHtml: string | null = null;
  private cachedCalendarSem: string | null = null;
  private cachedCalendarMonths: string[] | null = null;
  private cachedCalendarDays: Record<string, CalendarDay[]> = {};
  // Timetable is static for a semester — cache it so getCurrentSemesterId,
  // calculate_attendance and get_today_classes don't refetch it.
  private cachedTimetableHtml = new Map<string, string>();
  // Static-per-session identity/enrolment data (safe to cache; not the live
  // "status" pages like attendance/marks, which stay fresh / uncached).
  private cachedSemesters: { id: string; name: string }[] | null = null;
  private cachedProfileHtml: string | null = null;
  /**
   * Short-TTL caches for pages that are stable within a minute but were being
   * re-fetched on every call. Measured live: attendance ~760-1000ms, marks
   * ~614ms, exam schedule ~600ms — paid again for identical data on a repeat
   * question. Set VTOP_LIVE_CACHE_MS=0 to disable and always hit VTOP.
   */
  private liveCache = new Map<string, TtlCache<string>>();
  /** In-flight page fetches, so concurrent tool calls share one request. */
  private inflightPages = new Map<string, Promise<string>>();

  /** Per-key cache for live-but-stable pages (TTL from VTOP_LIVE_CACHE_MS). */
  private live<T>(key: string): TtlCache<string> {
    let c = this.liveCache.get(key);
    if (!c) {
      c = new TtlCache<string>(liveCacheTtlMs());
      this.liveCache.set(key, c);
    }
    return c;
  }

  /**
   * Fetch a page once even if several callers ask at the same time, then serve
   * repeats from the TTL cache.
   */
  private async fetchCachedPage(
    key: string,
    endpoint: string,
    payload: Record<string, string>,
    refresh = false,
  ): Promise<string> {
    const cache = this.live(key);
    if (!refresh) {
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const pending = this.inflightPages.get(key);
      if (pending) return pending;
    }
    const p = this.postWithAuth(endpoint, payload)
      .then((html) => cache.set(key, html))
      .finally(() => {
        if (this.inflightPages.get(key) === p) this.inflightPages.delete(key);
      });
    this.inflightPages.set(key, p);
    return p;
  }

  constructor(baseUrl?: string) {
    applySystemCATrust();
    this.baseUrl = baseUrl ?? process.env.VTOP_BASE_URL ?? DEFAULT_BASE_URL;

    const proxyUrl = resolveProxyUrl();
    if (proxyUrl) {
      console.error(
        `VtopMCP: proxy configured (${proxyUrl.replace(/\/\/[^@/]+@/, "//***@")}) — ` +
          (this.proxyAll
            ? "VTOP_PROXY_ALL set, routing ALL traffic through it."
            : "used only as a reCAPTCHA fallback for login; data stays direct."),
      );
    }

    this.jar = new CookieJar();
    this.rebuildClients();
  }

  /** (Re)build the direct + proxy axios instances around the current cookie jar. */
  private rebuildClients(): void {
    const proxyUrl = resolveProxyUrl() ?? null;
    this.directClient = this.buildClient(this.jar, null);
    this.proxyClient = proxyUrl ? this.buildClient(this.jar, proxyUrl) : null;
  }

  /** Client for authenticated data requests: direct, unless VTOP_PROXY_ALL. */
  private dataClient(): AxiosInstance {
    return this.proxyAll && this.proxyClient ? this.proxyClient : this.directClient;
  }

  /** Client that armed the current prelogin session (login must reuse it). */
  private loginClient(): AxiosInstance {
    return this.armedViaProxy && this.proxyClient ? this.proxyClient : this.directClient;
  }

  /**
   * Build an axios instance bound to a given cookie jar. `proxyUrl` null = a
   * direct connection; non-null = tunnel through that proxy. Extracted so a
   * restored session (importSession) can swap in a deserialized jar and rebuild.
   */
  private buildClient(jar: CookieJar, proxyUrl: string | null): AxiosInstance {
    const config = {
      baseURL: this.baseUrl,
      withCredentials: true,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        Referer: this.baseUrl + "/login",
      },
      maxRedirects: 5,
      // Per-request timeout. The default suits a direct connection; a residential
      // proxy (VTOP_PROXY_URL) adds latency, so it's bumpable via VTOP_TIMEOUT_MS.
      timeout: Number(process.env.VTOP_TIMEOUT_MS) || 30_000,
    };

    // Supply VTOP's missing intermediate so the chain verifies (keeps TLS
    // verification ON; see tls.ts). Scoped to this agent — other connections
    // (Redis, etc.) are untouched.
    const ca = vtopCaBundle();
    // Last-resort escape hatch for TLS-inspecting proxies whose CA is nowhere
    // in any trust store. Scoped to the VTOP agent only — unlike the old
    // NODE_TLS_REJECT_UNAUTHORIZED kill-switch, Redis and every other host
    // stay verified. Trusted networks only.
    const insecure = isTruthy(process.env.VTOP_INSECURE_TLS) ? { rejectUnauthorized: false } : {};
    if (isTruthy(process.env.VTOP_INSECURE_TLS)) {
      console.error(
        "VtopMCP: VTOP_INSECURE_TLS is set — TLS verification is disabled for VTOP connections only.",
      );
    }
    if (proxyUrl) {
      // Proxy path: a single agent both tunnels through the proxy and syncs the
      // cookie jar. proxy:false stops axios's own env-proxy logic from
      // double-tunneling.
      return axios.create({
        ...config,
        httpsAgent: new HttpsProxyCookieAgent(proxyUrl, { cookies: { jar }, ca, ...insecure }),
        proxy: false,
      });
    }
    // Direct path: cookie agent handles the jar at the socket level.
    return axios.create({
      ...config,
      httpsAgent: new HttpsCookieAgent({ cookies: { jar }, ca, ...insecure }),
      proxy: false,
    });
  }

  /**
   * Serialize the live session (cookies + auth identity) so it can be persisted
   * and rehydrated in a fresh process. Holds no plaintext credentials — the
   * caller encrypts the blob before storing.
   */
  exportSession(): VtopSession {
    return {
      cookies: this.jar.serializeSync() ?? null,
      authorizedID: this.authorizedID,
      csrf: this.csrfToken,
    };
  }

  /**
   * Restore a session produced by exportSession. Rebuilds the axios client
   * around the deserialized jar and marks the client authenticated; the first
   * authenticated request will transparently fall back to login if VTOP has
   * since expired the session. Corrupt blobs are ignored (left unauthenticated).
   */
  importSession(s: VtopSession): void {
    try {
      if (s.cookies) {
        this.jar = CookieJar.deserializeSync(s.cookies as never);
        this.rebuildClients();
      }
      this.authorizedID = s.authorizedID;
      this.csrfToken = s.csrf;
      this.authenticated = !!s.authorizedID;
    } catch {
      this.authenticated = false;
      this.authorizedID = null;
    }
  }

  /**
   * Touch VTOP with a cheap authenticated request so its server-side session
   * doesn't idle out, then re-persist (refreshing the store TTL). Returns
   * whether the session is still alive. Used by the keepalive loop.
   */
  async keepAlive(): Promise<boolean> {
    if (!this.authenticated || !this.authorizedID) return false;
    try {
      await this.postWithAuth(ENDPOINTS.profile, {});
      this.onSessionPersist?.();
      return true;
    } catch {
      // postWithAuth flips authenticated=false when VTOP reports the session
      // expired; a transient network error leaves it authenticated (we just
      // skip persisting this round).
      return this.authenticated;
    }
  }

  get isAuthenticated(): boolean {
    return this.authenticated;
  }

  /**
   * The logged-in student's VTOP registration number (the authorizedID), or
   * null when there is no session. Safe to expose — it is semi-public (it is
   * printed on the student's own marksheet) and it is what the user needs to
   * confirm they are asking about the right account.
   */
  get registrationNumber(): string | null {
    return this.authorizedID;
  }

  private extractCsrf(html: string): void {
    const match = html.match(CSRF_RE);
    if (match) this.csrfToken = match[1] ?? match[2];
  }

  /**
   * Extract authorizedID from a post-login response and, if found, also
   * refresh the CSRF token from the same HTML. Returns true on success.
   */
  private absorbAuthFromHtml(html: string): boolean {
    const match = html.match(AUTH_ID_RE);
    if (!match) return false;
    this.authorizedID = match[1] ?? match[2];
    this.authenticated = true;
    this.extractCsrf(html);
    return true;
  }

  /**
   * The /vtop/login page is a portal selector (Student/Employee/Parent/
   * Alumni) with no captcha. To reach the actual login page we GET it for
   * cookies, then POST /prelogin/setup?flag=VTOP to receive the student
   * login HTML (which embeds the captcha image).
   */
  private async initSession(viaProxy: boolean): Promise<string> {
    this.authenticated = false;
    this.authorizedID = null;

    // Start the prelogin with no cookies. A jar holding a dead JSESSIONID —
    // from a logout, or from a persisted session VTOP has since expired —
    // makes VTOP answer the GET /login below with HTTP 404 instead of minting
    // a fresh session (verified live). There is nothing worth keeping: the
    // arming cookies are minted by the two requests below, and login() reuses
    // this same jar afterwards.
    this.jar = new CookieJar();
    this.rebuildClients();
    const client = viaProxy && this.proxyClient ? this.proxyClient : this.directClient;

    const landingRes = await client.get("/login");
    this.extractCsrf(landingRes.data);

    const setupForm = new URLSearchParams();
    setupForm.append("flag", "VTOP");
    if (this.csrfToken) setupForm.append("_csrf", this.csrfToken);
    const setupRes = await client.post("/prelogin/setup", setupForm, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    this.extractCsrf(setupRes.data);
    return setupRes.data;
  }

  /** Diagnostic only: return the raw prelogin HTML that should contain the captcha. */
  async debugLoginPageHtml(): Promise<string> {
    return this.initSession(false);
  }

  /**
   * Re-roll the prelogin a few times on ONE client, looking for the OCR-able
   * image captcha (vs the unreadable Google reCAPTCHA VTOP serves on high risk
   * score). Returns the image if found, plus whether reCAPTCHA was seen.
   */
  private async tryCaptchaOn(
    label: "direct" | "proxy",
  ): Promise<{ image?: string; sawRecaptcha: boolean; lastHtml: string }> {
    const MAX_ATTEMPTS = 4;
    let lastHtml = "";
    let sawRecaptcha = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // initSession resets the jar and rebuilds the clients, so the label —
      // not a held instance — selects which client each attempt uses.
      // A dead network/VTOP outage must surface as a coded error, not a raw
      // AxiosError with no recovery plan.
      let html: string;
      try {
        html = await this.initSession(label === "proxy");
      } catch (err) {
        if (err instanceof VtopError) throw err;
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        if (status === 404) {
          throw new VtopError(
            "UPSTREAM",
            "VTOP did not serve the login page (HTTP 404).",
            "The prelogin handshake failed before any captcha was seen.",
          );
        }
        throw classify(err);
      }
      lastHtml = html;

      const match =
        html.match(
          /id="captchaBlock"[^>]*>[\s\S]*?<img[^>]+src="(data:image\/[^;]+;base64,[^"]+)"/,
        ) ??
        html.match(
          /<img[^>]+src="(data:image\/(?:png|jpeg|jpg);base64,[A-Za-z0-9+/=]+)"/,
        );
      if (match) {
        console.error(`VtopMCP: captcha image served via ${label} (attempt ${attempt}/${MAX_ATTEMPTS}).`);
        return { image: match[1], sawRecaptcha, lastHtml };
      }

      if (/data-sitekey="[^"]+"/i.test(html)) {
        sawRecaptcha = true;
        console.error(
          `VtopMCP: ${label} login page served Google reCAPTCHA (attempt ${attempt}/${MAX_ATTEMPTS}).`,
        );
      } else {
        console.error(
          `VtopMCP: ${label} — no captcha image found (attempt ${attempt}/${MAX_ATTEMPTS}). ${describeLoginPage(html)}`,
        );
      }

      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
      }
    }
    return { sawRecaptcha, lastHtml };
  }

  /**
   * Fetch the login page and pull out the base64 captcha image.
   *
   * Strategy: try DIRECT first (fast). Only if VTOP serves the unreadable
   * reCAPTCHA do we fall back to the residential proxy (which lowers the risk
   * score so the image variant is served). This keeps the common case fast and
   * uses the slow proxy strictly as a reCAPTCHA fallback. `armedViaProxy`
   * records which path armed the prelogin session so login() submits on it.
   * VTOP_PROXY_ALL skips the direct attempt.
   */
  async getCaptcha(): Promise<string> {
    if (!(this.proxyAll && this.proxyClient)) {
      const direct = await this.tryCaptchaOn("direct");
      if (direct.image) {
        this.armedViaProxy = false;
        return await this.prepareCaptcha(direct.image);
      }
      if (!this.proxyClient) {
        if (direct.sawRecaptcha) {
          throw new VtopError(
            "RECAPTCHA_REQUIRED",
            "VTOP served a Google reCAPTCHA instead of the readable image captcha, and no proxy is configured to fall back to.",
            `${describeLoginPage(direct.lastHtml)}. Set VTOP_PROXY_URL to a residential proxy so VTOP serves the image captcha.`,
          );
        }
        throw new VtopError(
          "CAPTCHA_NOT_FOUND",
          "Could not find a captcha image on the VTOP login page.",
          describeLoginPage(direct.lastHtml),
        );
      }
      console.error(
        "VtopMCP: direct login kept hitting reCAPTCHA — falling back to the proxy for this login (slower).",
      );
    }

    const viaProxy = await this.tryCaptchaOn("proxy");
    if (viaProxy.image) {
      this.armedViaProxy = true;
      return await this.prepareCaptcha(viaProxy.image);
    }
    this.armedViaProxy = false;
    if (viaProxy.sawRecaptcha) {
      console.error(
        "VtopMCP: reCAPTCHA served even through the proxy — the proxy IP may be flagged; retry shortly or rotate the proxy session.",
      );
      throw new VtopError(
        "RECAPTCHA_REQUIRED",
        "VTOP kept serving a Google reCAPTCHA even through the proxy, so no readable captcha was available.",
        `${describeLoginPage(viaProxy.lastHtml)}. The proxy exit IP may itself be flagged — wait a few minutes or rotate the proxy session.`,
      );
    }
    throw new VtopError(
      "CAPTCHA_NOT_FOUND",
      "Could not find a captcha image on the login page (via proxy).",
      describeLoginPage(viaProxy.lastHtml),
    );
  }

  /**
   * Prepare a freshly fetched captcha for delivery: optionally dump the raw
   * bytes to disk, then upscale it so clients that render small images poorly
   * can still read it. Returns the data URL to hand back to the client.
   */
  private async prepareCaptcha(dataUrl: string): Promise<string> {
    this.maybeDumpCaptcha(dataUrl);
    const upscaled = await upscaleCaptcha(dataUrl);
    if (upscaled !== dataUrl) {
      console.error(
        `VtopMCP: captcha upscaled for legibility (${await describeCaptchaSize(upscaled)}).`,
      );
    }
    return upscaled;
  }

  /**
   * Optionally write the captcha image to disk, for when the MCP client renders
   * it unreadably. VTOP's captcha is 200x40 — small enough that some clients
   * squash it to an illegible strip, and a misread costs a login attempt.
   * Set VTOP_DUMP_CAPTCHA=1 to save the raw bytes under VTOP_DUMP_DIR (default
   * test-output/) so it can be opened, upscaled, or read by a human.
   *
   * Fire-and-forget and never throws: dumping must not break login. Note the
   * dump only helps the session that fetched it — the captcha must still be
   * submitted from THIS client, or VTOP returns 404 (SESSION_MISMATCH).
   */
  private maybeDumpCaptcha(dataUrl: string): void {
    if (!/^(1|true|yes|on)$/i.test(process.env.VTOP_DUMP_CAPTCHA ?? "")) return;
    void (async () => {
      try {
        const fs = await import("node:fs/promises");
        const pathmod = await import("node:path");
        const dir = process.env.VTOP_DUMP_DIR || "test-output";
        await fs.mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const file = pathmod.join(dir, `captcha-${stamp}.jpg`);
        await fs.writeFile(
          file,
          Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ""), "base64"),
        );
        console.error(`VtopMCP: captcha dumped to ${file}`);
      } catch (err: unknown) {
        console.error(
          "VtopMCP: could not dump captcha:",
          err instanceof Error ? err.message : err,
        );
      }
    })();
  }

  /**
   * Submit credentials + captcha. On success the response contains a hidden
   * <input id="authorizedIDX"> whose value is required on every subsequent
   * authenticated POST. VTOP also rotates the CSRF token here.
   *
   * On any failure this THROWS a VtopError (it no longer returns
   * `{success:false}`), so every failure carries a code and a recovery plan
   * instead of a prose string the caller has to match on.
   */
  async login(
    username: string,
    password: string,
    captcha: string
  ): Promise<{ success: true; message: string }> {
    const formData = new URLSearchParams();
    formData.append("username", username);
    formData.append("password", password);
    formData.append("captchaStr", captcha);
    formData.append("gResponse", captcha);
    if (this.csrfToken) formData.append("_csrf", this.csrfToken);

    // Submit on the same client that armed the prelogin session (direct, or the
    // proxy if getCaptcha fell back to it).
    const loginClient = this.loginClient();
    try {
      const res = await loginClient.post("/login", formData, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      const html: string = res.data;

      if (this.absorbAuthFromHtml(html)) {
        this.consecutiveBadCreds = 0;
        this.onSessionPersist?.();
        if (this.authorizedID) this.onLogin?.(this.authorizedID);
        console.error("VtopMCP: login OK.");
        return { success: true, message: "Successfully logged in to VTOP." };
      }

      const lower = html.toLowerCase();
      if (/invalid\s*captcha/.test(lower)) {
        console.error("VtopMCP: login failed — VTOP reported invalid captcha (OCR misread or expired).");
        throw new VtopError(
          "INVALID_CAPTCHA",
          "VTOP rejected the captcha text.",
          "Usually an OCR misread, or the captcha expired between get_captcha and login.",
        );
      }
      // VTOP's wording varies ("Invalid Username/Password" with a slash,
      // "Invalid Username or Password" without). Match the nouns and the
      // connector loosely so a wrong password is never misreported as a
      // retryable UPSTREAM — retrying it only burns attempts toward lockout.
      if (
        /invalid\s*(user\s*name|username|login\s*id|user\s*id)[\s/]*(or|\/)?[\s/]*password/.test(
          lower
        ) ||
        /wrong\s*(user\s*name|username|password)/.test(lower)
      ) {
        console.error("VtopMCP: login failed — invalid username/password.");
        if (++this.consecutiveBadCreds >= 3) {
          throw new VtopError(
            "MAX_LOGIN_ATTEMPTS",
            "Three consecutive bad-credential rejections; refusing to try again locally so the account is not locked.",
            "Ask the user for fresh credentials instead of retrying the same pair.",
          );
        }
        throw new VtopError(
          "INVALID_CREDENTIALS",
          "VTOP rejected the username or password.",
        );
      }
      if (/account\s*(is\s*)?locked/.test(lower)) {
        console.error("VtopMCP: login failed — account locked.");
        throw new VtopError(
          "ACCOUNT_LOCKED",
          "VTOP reports this account is locked. Contact VIT administration.",
        );
      }
      if (/maximum\s*fail\s*attempts\s*reached/.test(lower)) {
        console.error("VtopMCP: login failed — maximum fail attempts reached.");
        throw new VtopError(
          "MAX_LOGIN_ATTEMPTS",
          "Too many failed attempts. Log in once via the VTOP website to reset.",
        );
      }

      // Some VTOP deployments redirect post-login through /content rather
      // than returning the home page inline; try that as a fallback.
      try {
        const contentRes = await loginClient.get("/content");
        if (this.absorbAuthFromHtml(contentRes.data)) {
          this.consecutiveBadCreds = 0;
          this.onSessionPersist?.();
          if (this.authorizedID) this.onLogin?.(this.authorizedID);
          console.error("VtopMCP: login OK (via /content fallback).");
          return { success: true, message: "Successfully logged in to VTOP." };
        }
      } catch {
        /* ignore */
      }

      this.authenticated = false;
      console.error(
        `VtopMCP: login failed — unrecognized response (htmlLen=${html.length}). ${describeLoginPage(html)}`,
      );
      throw new VtopError(
        "UPSTREAM",
        "Login failed with an unrecognized response from VTOP.",
        describeLoginPage(html),
      );
    } catch (err: unknown) {
      // Re-raise our own coded failures untouched; only classify foreign ones.
      if (err instanceof VtopError) throw err;
      this.authenticated = false;
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      // VTOP returns a Tomcat 404 on POST /login when the session wasn't armed
      // by the prelogin handshake — i.e. this captcha belongs to a different
      // session than the one we're posting from. The captcha can't be replayed
      // on a fresh session, so the only recovery is a brand-new captcha.
      if (status === 404 || /status code 404/.test(String(err))) {
        console.error("VtopMCP: login failed — VTOP 404 (prelogin session not armed on this client).");
        throw new VtopError(
          "SESSION_MISMATCH",
          "VTOP did not recognize this captcha's session (HTTP 404).",
          "The prelogin handshake and the login POST landed on different VTOP sessions; the captcha cannot be replayed.",
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`VtopMCP: login request error${status ? ` (status ${status})` : ""}: ${msg}`);
      throw classify(err);
    }
  }

  async logout(): Promise<void> {
    try {
      await this.dataClient().get("/processLogout");
    } catch {
      /* ignore */
    }
    this.authenticated = false;
    this.authorizedID = null;
    this.csrfToken = null;
    this.cachedActiveSemesterId = null;
    this.cachedGradeHistoryHtml = null;
    this.cachedCalendarSem = null;
    this.cachedCalendarMonths = null;
    this.cachedCalendarDays = {};
    this.cachedTimetableHtml.clear();
    this.cachedSemesters = null;
    this.cachedProfileHtml = null;
    // A new session must never serve pages fetched under the old one.
    this.liveCache.clear();
    this.inflightPages.clear();
    // Drop the cookies too. /processLogout invalidates the JSESSIONID
    // server-side, and VTOP answers a subsequent GET /login that still carries
    // the dead session cookie with HTTP 404 instead of minting a fresh session
    // (verified live: post-logout getCaptcha failed twice with UPSTREAM 404 on
    // GET /vtop/login, while a fresh jar succeeded). Keeping the jar would leave
    // every later login broken until the process restarted.
    this.jar = new CookieJar();
    this.rebuildClients();
    this.onSessionClear?.();
  }

  // --- hostel leave ---------------------------------------------------------

  /**
   * The leave REQUEST form (leaveCode dropdown, options, proctor name).
   * VTOP's menu-unavailable modal is the failure mode worth catching here: it
   * comes back as HTTP 200, so without this check a broken route is silently
   * parsed into "no leave types found".
   */
  async getLeaveFormHtml(): Promise<string> {
    // Prime the module first. leave/2 is only reachable once leave/1 has been
    // loaded for this session: posted cold it returns HTTP 200 carrying
    // "Sorry, Unable to process your request." rather than the form. Same
    // nav-state quirk the academic calendar needed.
    await this.postWithAuth(ENDPOINTS.leavePage, {
      [LEAVE_CONTROL.apply]: "",
      form: "undefined",
      control: LEAVE_CONTROL.apply,
      x: new Date().toUTCString(),
    });

    // Mirrors the page's own requestUpdate(): the control's own name as an
    // empty field, plus a literal form=undefined because these nav buttons
    // carry no form name.
    const html = await this.postWithAuth(ENDPOINTS.leaveForm, {
      [LEAVE_CONTROL.apply]: "",
      form: "undefined",
      control: LEAVE_CONTROL.apply,
      x: new Date().toUTCString(),
    });
    this.assertLeaveReachable(html, "leave request form");
    return html;
  }

  /** The leave STATUS view (pending/approved requests). */
  async getLeaveStatusHtml(): Promise<string> {
    // Same priming requirement as the request form.
    await this.postWithAuth(ENDPOINTS.leavePage, {
      [LEAVE_CONTROL.status]: "",
      form: "undefined",
      control: LEAVE_CONTROL.status,
      x: new Date().toUTCString(),
    });
    const html = await this.postWithAuth(ENDPOINTS.leaveStatus, {
      [LEAVE_CONTROL.status]: "",
      form: "undefined",
      control: LEAVE_CONTROL.status,
      x: new Date().toUTCString(),
    });
    this.assertLeaveReachable(html, "leave status");
    return html;
  }

  /**
   * SUBMIT a leave application. This writes to VTOP.
   *
   * Deliberately separate from the getters so that every call site is obvious
   * in review, and so nothing can reach this by accident from a read path.
   */
  async submitLeaveApplication(fields: Record<string, string>): Promise<string> {
    return this.postWithAuth(ENDPOINTS.leaveSubmit, {
      ...fields,
      form: LEAVE_FORM_NAME,
      control: LEAVE_CONTROL.submit,
      x: new Date().toUTCString(),
    });
  }

  /**
   * WITHDRAW a leave application. This writes to VTOP.
   *
   * VTOP publishes no documented cancel endpoint, so the withdraw target is
   * read at runtime from the status view (parseLeaveCancelControls) instead
   * of guessed. Only plain-link controls are followed; script-call controls
   * fail loud with their function name and args, so a live sighting can wire
   * them without guessing. Deliberately separate from the getters.
   */
  async cancelLeaveApplication(leaveId: string): Promise<string> {
    const wanted = leaveId.trim().toUpperCase();
    const controls = parseLeaveCancelControls(await this.getLeaveStatusHtml());
    const ctl = controls.find((c) => c.leaveId.toUpperCase() === wanted);
    if (!ctl) {
      throw new VtopError(
        "UPSTREAM",
        `VTOP published no withdraw control for leave ${leaveId.trim()}.`,
        "Only rows carrying a cancel/withdraw link can be withdrawn through this path. " +
          "An approved or already-closed leave typically offers none.",
      );
    }
    if (ctl.kind !== "href") {
      throw new VtopError(
        "UPSTREAM",
        `Withdraw control for leave ${leaveId.trim()} is a script call (${ctl.action || "unknown"}), not a link.`,
        `Args seen: ${JSON.stringify(ctl.params)}. Report this shape so the control can be wired without guessing.`,
      );
    }
    const url = new URL(ctl.action || ENDPOINTS.leaveStatus, `${this.baseUrl}/`);
    for (const [k, v] of Object.entries(ctl.params)) url.searchParams.append(k, v);
    const path = url.pathname.startsWith("/vtop/")
      ? url.pathname.slice("/vtop".length)
      : url.pathname;
    const res = await this.dataClient().get(path + url.search);
    return res.data as string;
  }

  /**
   * Fetch the constraints VTOP publishes for one leave type.
   *
   * Reproduces what the leaveCode dropdown does in the browser: selecting a
   * type fires requestUpdate() with control=leaveCode, and the response may
   * carry type-specific rules — notably the maximum number of days, which is
   * otherwise only discoverable by submitting and being rejected.
   *
   * This is a READ. It never submits an application.
   */
async getLeaveTypeConstraints(leaveCode: string): Promise<string> {
    // Establish nav state; leave/2 is not reachable cold.
    await this.postWithAuth(ENDPOINTS.leavePage, {
      [LEAVE_CONTROL.apply]: "",
      form: "undefined",
      control: LEAVE_CONTROL.apply,
      x: new Date().toUTCString(),
    });
    return this.postWithAuth(ENDPOINTS.leaveForm, {
      [LEAVE_TYPE_CONTROL]: leaveCode,
      form: "undefined",
      control: LEAVE_TYPE_CONTROL,
      x: new Date().toUTCString(),
    });
  }

  /**
   * VTOP answers an unusable menu with HTTP 200 carrying a "This menu is not
   * available at present!!!" modal. Treat that as a failure, because otherwise
   * it parses as a page that merely happens to have no leave data in it.
   */
  private assertLeaveReachable(html: string, what: string): void {
    if (/this menu is not available/i.test(html)) {
      throw new VtopError(
        "ENDPOINT_NOT_FOUND",
        `VTOP would not serve the ${what}.`,
        "The portal returned 'This menu is not available at present!'. Either the " +
          "hostel leave module is disabled for this account, or the route has " +
          "changed. This is not a session problem — do not log in again.",
      );
    }
    // VTOP's generic internal-error page. Also HTTP 200, and it parses as an
    // empty leave list unless it is caught here — which reads as "you have no
    // leave records" rather than "the request failed".
    if (/unable to process your request/i.test(html)) {
      throw new VtopError(
        "UPSTREAM",
        `VTOP could not serve the ${what}.`,
        "The portal returned its internal error page ('Sorry, Unable to process " +
          "your request'). The route exists but rejected the request — usually " +
          "nav state or a parameter shape VTOP did not accept. This is NOT a " +
          "session problem; re-logging in will not help.",
      );
    }
  }

  /** Timetable HTML for a semester, cached for the session (it doesn't change). */
  async getTimetableHtml(semesterId: string): Promise<string> {
    const cached = this.cachedTimetableHtml.get(semesterId);
    if (cached) return cached;
    const html = await this.fetchPage(ENDPOINTS.timetable, { semesterSubId: semesterId });
    this.cachedTimetableHtml.set(semesterId, html);
    return html;
  }

  /** Marks page for a semester, TTL-cached (default 60s). */
  getMarksHtml(semesterId: string, refresh = false): Promise<string> {
    return this.fetchCachedPage(`marks:${semesterId}`, ENDPOINTS.marks, { semesterSubId: semesterId }, refresh);
  }

  /** Attendance page for a semester, TTL-cached (default 60s). */
  getAttendanceHtml(semesterId: string, refresh = false): Promise<string> {
    return this.fetchCachedPage(`attendance:${semesterId}`, ENDPOINTS.attendance, { semesterSubId: semesterId }, refresh);
  }

  /**
   * Per-class detail for one course (processViewAttendanceDetail). The Bhopal
   * request shape (semesterSubId/registerNumber/courseId/courseType, from the
   * row's callStudentAttendanceDetailDisplay handle) was reconstructed from
   * page markup and is UNVERIFIED against a live request — so the response is
   * validated: no detail table means UPSTREAM, never an empty success. First
   * live use that throws here means the payload shape needs correcting, not
   * that the course has no detail.
   */
  async getAttendanceDetailHtml(params: Record<string, string>): Promise<string> {
    this.ensureAuthenticated();
    const html = await this.postWithAuth(ENDPOINTS.attendanceDetail, {
      ...params,
      x: new Date().toUTCString(),
    });
    if (!hasAttendanceDetailTable(html)) {
      throw new VtopError(
        "UPSTREAM",
        "VTOP returned no per-class detail table for these parameters.",
        "The detail request shape may be wrong for this campus, or the course has no detail view. Not treated as empty attendance.",
      );
    }
    return html;
  }

  /** Exam schedule for a semester, TTL-cached (default 60s). */
  getExamScheduleHtml(semesterId: string, refresh = false): Promise<string> {
    return this.fetchCachedPage(
      `exams:${semesterId}`,
      ENDPOINTS.examSchedule,
      { semesterSubId: semesterId },
      refresh,
    );
  }

  /**
   * Auto-detect the semester the student is actively enrolled in.
   *
   * Cannot just pick semesters[0]: VIT's dropdown lists Fall/Winter/Summer
   * regardless of enrolment, and Summer Term (≈May–July) is mostly arrears
   * so many students see it at index 0 with nothing in it. Probe the
   * timetable for each of the most recent few semesters and return the
   * first that has real course rows. Cached for the rest of the session.
   */
  async getCurrentSemesterId(): Promise<string> {
    if (this.cachedActiveSemesterId) return this.cachedActiveSemesterId;

    const semesters = await this.getSemesters();
    if (semesters.length === 0) {
      throw new Error("No semesters available on VTOP for this account.");
    }

    // Probe the recent semesters' timetables concurrently, then pick the first
    // (in dropdown order) that has real course rows. Caches the winning
    // timetable HTML so the data tools don't refetch it.
    const candidates = semesters.slice(0, MAX_PROBE_SEMESTERS);
    const probes = await Promise.allSettled(
      candidates.map((sem) => this.postWithAuth(ENDPOINTS.timetable, { semesterSubId: sem.id })),
    );
    for (let i = 0; i < candidates.length; i++) {
      const r = probes[i];
      if (r.status === "fulfilled" && COURSE_CODE_PATTERN.test(r.value)) {
        this.cachedActiveSemesterId = candidates[i].id;
        this.cachedTimetableHtml.set(candidates[i].id, r.value);
        return candidates[i].id;
      }
    }
    // A session-expiry on any probe should surface so the caller can re-login,
    // rather than silently falling back to the wrong semester.
    const authFail = probes.find(
      (r): r is PromiseRejectedResult =>
        r.status === "rejected" && isNotAuthenticated(r.reason),
    );
    if (authFail) throw authFail.reason;

    this.cachedActiveSemesterId = semesters[0].id;
    return semesters[0].id;
  }

  async getSemesters(): Promise<{ id: string; name: string }[]> {
    this.ensureAuthenticated();
    if (this.cachedSemesters) return this.cachedSemesters;
    const html = await this.postWithAuth(ENDPOINTS.timetableForSemesters, {
      verifyMenu: "true",
      nocache: String(Date.now()),
    });

    const semesters: { id: string; name: string }[] = [];
    const optionRegex = /<option\s+value="([^"]*)"[^>]*>([^<]+)<\/option>/gi;
    let match;
    while ((match = optionRegex.exec(html)) !== null) {
      const id = match[1].trim();
      const name = match[2].trim();
      if (id) semesters.push({ id, name });
    }
    this.cachedSemesters = semesters;
    return semesters;
  }

  /** Profile HTML, cached for the session (it doesn't change). */
  async getProfileHtml(): Promise<string> {
    if (this.cachedProfileHtml) return this.cachedProfileHtml;
    const html = await this.fetchPage(ENDPOINTS.profile, {
      verifyMenu: "true",
      nocache: String(Date.now()),
    });
    this.cachedProfileHtml = html;
    return html;
  }

  /**
   * Fetch a simple verifyMenu page (no priming, no form fields). Used by the
   * read-only info pages that the browser reaches with a plain
   * verifyMenu/authorizedID/_csrf POST: acknowledgments, proctor details,
   * curriculum baskets, fee receipts, leave history.
   */
  private async getInfoPage(endpoint: string, what?: string): Promise<string> {
    const html = await this.fetchPage(endpoint, {
      verifyMenu: "true",
      nocache: String(Date.now()),
    });
    // VTOP answers a disabled/unreachable module with HTTP 200 carrying an
    // error modal. That must raise ENDPOINT_NOT_FOUND here — never flow into
    // a parser as "no records".
    this.assertLeaveReachable(html, what ?? endpoint);
    return html;
  }

  /** Admission document checklist (Submitted / Not Applicable / Not Submitted). */
  async getAcknowledgmentsHtml(): Promise<string> {
    return this.getInfoPage(ENDPOINTS.acknowledgments, "acknowledgments");
  }

  /** Standalone proctor view. Same data as the profile's proctor section. */
  async getProctorDetailsHtml(): Promise<string> {
    return this.getInfoPage(ENDPOINTS.proctorDetails, "proctor details");
  }

  /**
   * Faculty directory name search (Academics → Faculty Info). The page's own
   * getEmployeeInfo() posts the name fragment as `empId` (letters/spaces,
   * minimum 3 characters — enforced by the tool, mirroring the page).
   */
  async searchFacultyHtml(name: string): Promise<string> {
    return this.fetchPage(ENDPOINTS.facultySearch, {
      empId: name.trim(),
      x: new Date().toUTCString(),
    });
  }

  /**
   * One faculty member's detail card, keyed by the search row's employee id
   * (the Action button's id / getEmployeeIdNo("...") onclick). Same `empId`
   * field the page's getEmployeeIdNo() sends.
   */
  async getFacultyDetailHtml(employeeId: string): Promise<string> {
    return this.fetchPage(ENDPOINTS.facultyDetail, {
      empId: employeeId.trim(),
      x: new Date().toUTCString(),
    });
  }

  /**
   * Student profile photo bytes. GET users/image/?id={regNo} — the avatar on
   * every logged-in page. The `id` is the session's own authorizedID (the
   * registration number), never a caller-supplied value.
   */
  async downloadProfilePicture(): Promise<{ bytes: Buffer; contentType: string }> {
    return this.downloadBytes(ENDPOINTS.profilePicture, {
      id: this.authorizedID!,
      x: new Date().toUTCString(),
    });
  }

  /**
   * Per-course syllabus PDF bytes. GET courseSyllabusDownload1/{CODE} — the
   * URL the page's vtopDownload() opens. Callers must verify the %PDF header:
   * VTOP answers failures as HTTP 200 HTML, and downloadBytes only rejects
   * bodies it recognises as error pages.
   */
  async downloadCourseSyllabus(
    courseCode: string,
  ): Promise<{ bytes: Buffer; contentType: string }> {
    return this.downloadBytes(
      `${ENDPOINTS.courseSyllabusDownload}/${courseCode.trim().toUpperCase()}`,
      { x: new Date().toUTCString() },
    );
  }

  /** Programme curriculum baskets (per-category course tables). */
  async getCurriculumBasketsHtml(): Promise<string> {
    return this.getInfoPage(ENDPOINTS.curriculumBaskets, "curriculum baskets");
  }

  /** Fee receipt list (number/date/amount/campus). */
  async getFeeReceiptsHtml(): Promise<string> {
    return this.getInfoPage(ENDPOINTS.feeReceipts, "fee receipts");
  }

  /**
   * One receipt's detail HTML (as rendered into the page's receipt panel).
   *
   * Accepts a bare number ("22222") or the full ref as printed on the list's
   * VIEW button ("22222/8/BPL"). A bare number is resolved against the list's
   * onclick refs — never synthesised — so a campus/segment change surfaces as
   * UPSTREAM instead of a silent detail miss.
   */
  async getFeeReceiptDetailHtml(receitNo: string): Promise<string> {
    this.ensureAuthenticated();
    const listHtml = await this.getFeeReceiptsHtml();
    let ref = receitNo.trim();
    if (!ref.includes("/")) {
      const m = listHtml.match(
        new RegExp(`doDuplicateReceipt\\(['"](${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^'"]+)['"]\\)`)
      );
      if (!m) {
        throw new VtopError(
          "UPSTREAM",
          `No receipt ref on file for number "${ref}".`,
          "The receipt list carries no VIEW button for it — it may not exist, or the list layout changed.",
        );
      }
      ref = m[1];
    }
    const hidden = (name: string): string => {
      const m = listHtml.match(
        new RegExp(`<input[^>]+name="${name}"[^>]+value="([^"]*)"`, "i"),
      ) ?? listHtml.match(
        new RegExp(`<input[^>]+value="([^"]*)"[^>]+name="${name}"`, "i"),
      );
      return m ? m[1] : "";
    };
    return this.postWithAuth(ENDPOINTS.feeReceiptDetail, {
      receitNo: ref,
      applno: hidden("applno"),
      registerNumber: hidden("regno") || hidden("registerNumber") || this.registrationNumber || "",
      authorizedID: this.authorizedID!,
      x: new Date().toUTCString(),
    });
  }

  /** Full leave history (status + approved past records + gate-pass state). */
  async getLeaveHistoryHtml(): Promise<string> {
    return this.getInfoPage(ENDPOINTS.leaveHistory, "leave history");
  }

  /**
   * Fetch grade-history HTML, caching it for the rest of the session.
   * Both get_grade_history and get_curriculum_progress parse this same
   * response, so we don't want to hit VTOP twice when chained.
   */
  async getGradeHistoryHtml(): Promise<string> {
    if (this.cachedGradeHistoryHtml) return this.cachedGradeHistoryHtml;
    const html = await this.fetchPage(ENDPOINTS.gradeHistory, {
      verifyMenu: "true",
      nocache: String(Date.now()),
    });
    // Only cache a page that actually carries grade content. VTOP occasionally
    // returns a transient empty/error shell (still HTTP 200, no expiry marker);
    // caching that would poison every grade/curriculum call for the whole
    // session. Leaving it uncached lets the next call refetch a good page.
    if (/cgpa/i.test(html) || COURSE_CODE_PATTERN.test(html)) {
      this.cachedGradeHistoryHtml = html;
    }
    return html;
  }

  /**
   * Fetch the academic calendar (instructional days, holidays, day-order
   * overrides) for the months overlapping [fromISO, toISO]. Three-step VTOP
   * flow: load the calendar page for context, fetch the month buttons, then
   * fetch each needed month's day table. Month list + parsed months are cached
   * per semester AND class group for the session.
   *
   * classGroupId selects whose calendar: COMB (combined, the default), ALL
   * (General), FS (Freshers), FT (Fast Track) and programme variants. VTOP
   * publishes the list per semester; anything unrecognised returns whatever
   * VTOP serves for it rather than an invented error.
   */
  async getCalendar(
    semesterId: string,
    fromISO: string,
    toISO: string,
    classGroupId = "COMB",
  ): Promise<CalendarDay[]> {
    this.ensureAuthenticated();
    const x = () => new Date().toUTCString();
    const cacheKey = `${semesterId}|${classGroupId}`;

    if (this.cachedCalendarSem !== cacheKey || !this.cachedCalendarMonths) {
      // Loading the page first establishes the calendar context; the month-list
      // and month actions 404 otherwise (same nav-state quirk as login).
      await this.postWithAuth(ENDPOINTS.calendarPreview, {});
      const listHtml = await this.postWithAuth(ENDPOINTS.calendarMonthList, {
        paramReturnId: "getListForSemester",
        semSubId: semesterId,
        classGroupId,
        x: x(),
      });
      const months = parseCalendarMonths(listHtml);
      // An error shell parses to zero months. Caching that would poison every
      // getCalendar call for the whole session (all zero upcomingSessions
      // with no warning), so refuse and let the next call refetch —
      // mirroring the grade-history guard.
      if (months.length === 0) {
        throw new VtopError(
          "UPSTREAM",
          "VTOP returned no calendar months for this semester.",
          "The month list came back empty; the portal may have served an error page. Not treated as 'teaching over'.",
        );
      }
      this.cachedCalendarMonths = months;
      this.cachedCalendarSem = cacheKey;
      this.cachedCalendarDays = {};
    }

    const fromYM = fromISO.slice(0, 7);
    const toYM = toISO.slice(0, 7);
    const wanted = this.cachedCalendarMonths.filter((cd) => {
      const ym = calDateMonthKey(cd);
      return ym && ym >= fromYM && ym <= toYM;
    });
    // Fetch any uncached months in the range concurrently. Only cache months
    // that actually parsed to days — an error shell parses to [] and must
    // not poison the session cache.
    const missing = wanted.filter((cd) => !this.cachedCalendarDays[cd]);
    await pMap(missing, async (cd) => {
      const html = await this.postWithAuth(ENDPOINTS.calendarMonth, {
        calDate: cd,
        semSubId: semesterId,
        classGroupId,
        x: x(),
      });
      const days = parseAcademicCalendar(html, cd);
      if (days.length > 0) this.cachedCalendarDays[cd] = days;
    });

    const out: CalendarDay[] = [];
    for (const cd of wanted) out.push(...(this.cachedCalendarDays[cd] ?? []));
    // VTOP serves a calendar MONTH at a time, so `wanted` covers whole months.
    // Trim to the window actually asked for, so callers get the dates they
    // requested rather than a month of extras they must filter out themselves.
    const inWindow = out.filter((d) => d.date >= fromISO && d.date <= toISO);
    inWindow.sort((a, b) => a.date.localeCompare(b.date));
    return inWindow;
  }

  async fetchPage(
    endpoint: string,
    payload?: Record<string, string>
  ): Promise<string> {
    this.ensureAuthenticated();
    return this.postWithAuth(endpoint, payload);
  }

  /**
   * GET an endpoint as raw bytes (syllabus PDFs). Auth fields ride as query
   * params, matching the page's vtopDownload() window.open URL. Returns the
   * bytes plus the served content type so callers can fail loud on a non-PDF:
   * VTOP answers failures as HTTP 200 carrying HTML, never a bare error, and
   * saving that HTML as ".pdf" would be a lie shaped like a success.
   */
  async downloadBytes(
    endpoint: string,
    extraParams?: Record<string, string>
  ): Promise<{ bytes: Buffer; contentType: string }> {
    this.ensureAuthenticated();
    const MAX_404_RETRIES = 1;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.dataClient().get(endpoint, {
          params: {
            authorizedID: this.authorizedID!,
            ...(this.csrfToken ? { _csrf: this.csrfToken } : {}),
            ...extraParams,
          },
          responseType: "arraybuffer",
        });
        const bytes = Buffer.from(res.data);
        const contentType: string = String(res.headers?.["content-type"] ?? "");
        if (/html/i.test(contentType) || bytes.subarray(0, 1).toString() === "<") {
          const head = bytes.subarray(0, 2000).toString("latin1").toLowerCase();
          if (
            head.includes("not authorized") ||
            head.includes("session expired") ||
            head.includes("vtoploginform")
          ) {
            this.authenticated = false;
            this.authorizedID = null;
            this.liveCache.clear();
            this.inflightPages.clear();
            throw new VtopError(
              "NOT_AUTHENTICATED",
              "VTOP session expired.",
              `VTOP returned an expired/unauthorized page for ${endpoint}.`,
            );
          }
          throw new VtopError(
            "UPSTREAM",
            `VTOP answered the ${endpoint} download with an HTML page, not a file.`,
            head.slice(0, 200),
          );
        }
        return { bytes, contentType };
      } catch (err: unknown) {
        if (isNotAuthenticated(err)) {
          throw err;
        }
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        const is404 = status === 404 || /status code 404/.test(String(err));
        if (is404) {
          if (attempt < MAX_404_RETRIES) {
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          // Same split as postWithAuth: a lone 404 names a bad path, a 404
          // plus a failing known-good probe names a dead session.
          if (await this.sessionLooksDead(endpoint)) {
            this.authenticated = false;
            this.authorizedID = null;
            this.liveCache.clear();
            this.inflightPages.clear();
            throw new VtopError(
              "NOT_AUTHENTICATED",
              "VTOP session expired.",
              `${endpoint} returned 404 twice, and a known-good endpoint also failed, so the session really is dead.`,
            );
          }
          throw new VtopError(
            "ENDPOINT_NOT_FOUND",
            `VTOP has no endpoint at "${endpoint}".`,
            "HTTP 404 twice on an authenticated request, while a known-good endpoint still works. " +
              "The path is wrong or renamed; the session is fine.",
          );
        }
        if (err instanceof VtopError) {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to download ${endpoint}: ${msg}`);
      }
    }
  }

  private ensureAuthenticated(): void {
    if (!this.authenticated || !this.authorizedID) {
      throw new VtopError("NOT_AUTHENTICATED", "No active VTOP session.");
    }
  }

  /**
   * True only when an endpoint this client already knows works also fails.
   *
   * Used to tell a genuinely dead session apart from a single endpoint that
   * does not exist. Bails out to `false` on anything ambiguous — a probe that
   * cannot reach a verdict must not be allowed to log the user out.
   */
  private async sessionLooksDead(failingEndpoint: string): Promise<boolean> {
    // Never re-probe the endpoint that just failed; that proves nothing.
    if (failingEndpoint === ENDPOINTS.timetable) return false;
    try {
      // Must carry the same auth fields a real request does. An earlier version
      // POSTed a bare body, which VTOP 404s unconditionally — so the probe
      // "confirmed" a dead session on every single 404 and the fix was inert.
      // Same shape as getTimetableHtml (including semesterSubId when known),
      // so a 404 means the session is dead rather than the params are wrong.
      const formData = new URLSearchParams();
      formData.append("authorizedID", this.authorizedID!);
      if (this.csrfToken) formData.append("_csrf", this.csrfToken);
      if (this.cachedActiveSemesterId) {
        formData.append("semesterSubId", this.cachedActiveSemesterId);
      }
      const res = await this.dataClient().post(ENDPOINTS.timetable, formData, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      const body: string = res.data;
      // A dead session comes back as the login page, not timetable markup.
      if (/name=["']?password["']?/i.test(body) || /\/vtop\/login/i.test(body)) {
        return true;
      }
      return false;
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const msg = err instanceof Error ? err.message : String(err);
      // Only a 404 on a known-good endpoint is evidence of a dead session.
      // A timeout or network blip is NOT — treat that as "can't tell".
      if (status === 404 || /status code 404/.test(msg)) return true;
      return false;
    }
  }

  private async postWithAuth(
    endpoint: string,
    extraParams?: Record<string, string>
  ): Promise<string> {
    const formData = new URLSearchParams();
    formData.append("authorizedID", this.authorizedID!);
    if (this.csrfToken) formData.append("_csrf", this.csrfToken);
    if (extraParams) {
      for (const [key, value] of Object.entries(extraParams)) {
        formData.append(key, value);
      }
    }

    // One retry to absorb a genuine transient blip; a 404 that persists past it
    // is treated as an expired session (see below).
    const MAX_404_RETRIES = 1;
    for (let attempt = 0; ; attempt++) {
      try {
        // Authenticated data goes direct (fast) — see dataClient().
        const res = await this.dataClient().post(endpoint, formData, {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        const html: string = res.data;

        if (process.env.VTOP_DUMP_HTML && process.env.VTOP_DUMP_DIR) {
          // Debug aid only: must never be able to fail a real data fetch.
          // Create the directory (it usually doesn't exist yet) and swallow any
          // error — previously a missing VTOP_DUMP_DIR threw ENOENT from inside
          // this try block and turned every data tool into "UPSTREAM: no such
          // file or directory".
          // Identity pages (profile, proctor) are never dumped: they carry
          // family/hostel PII that must not land on disk as a side effect.
          const identityPage = /studentsRecord|proctor/i.test(endpoint);
          if (identityPage) {
            console.error(`VtopMCP: skipping HTML dump for identity page ${endpoint}.`);
          }
          try {
            if (!identityPage) {
              const fs = await import("node:fs/promises");
              const path = await import("node:path");
              const dir = process.env.VTOP_DUMP_DIR;
              await fs.mkdir(dir, { recursive: true });
              const safe = endpoint.replace(/[^\w-]+/g, "_");
              await fs.writeFile(path.join(dir, `${safe}.html`), html);
            }
          } catch (err: unknown) {
            console.error(
              "VtopMCP: could not dump HTML for",
              endpoint,
              "-",
              err instanceof Error ? err.message : err,
            );
          }
        }

        const lower = html.toLowerCase();
        if (
          lower.includes("not authorized") ||
          lower.includes("session expired") ||
          lower.includes("vtoploginform")
        ) {
          this.authenticated = false;
          this.authorizedID = null;
          console.error(`VtopMCP: VTOP session expired/unauthorized during ${endpoint}.`);
          // Anything cached under the dead session is now suspect.
          this.liveCache.clear();
          this.inflightPages.clear();
          throw new VtopError(
            "NOT_AUTHENTICATED",
            "VTOP session expired.",
            `VTOP returned an expired/unauthorized page for ${endpoint}.`,
          );
        }

        return html;
      } catch (err: unknown) {
        if (isNotAuthenticated(err)) {
          throw err;
        }
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        const is404 = status === 404 || /status code 404/.test(String(err));
        if (is404) {
          if (attempt < MAX_404_RETRIES) {
            console.error(
              `VtopMCP: ${endpoint} returned 404 (attempt ${attempt + 1}) — retrying once in case it's a transient VTOP blip.`,
            );
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          // VTOP serves 404 for some endpoints (e.g. academics/common/*) when
          // the session is dead rather than the login page, so a persistent 404
          // used to be read as expiry. But a 404 is ALSO what you get for a
          // path that simply does not exist — and treating that as a dead
          // session destroys a perfectly good one, then tells the client to
          // re-authenticate for nothing (and burns a captcha doing it).
          //
          // So verify before concluding anything: probe an endpoint this client
          // already knows works. Only if THAT also 404s is the session really
          // dead. Otherwise report the endpoint as missing and keep the
          // session intact.
          if (await this.sessionLooksDead(endpoint)) {
            this.authenticated = false;
            this.authorizedID = null;
            this.liveCache.clear();
            this.inflightPages.clear();
            console.error(
              `VtopMCP: ${endpoint} still 404 and a known-good endpoint also failed — treating as an expired session.`,
            );
            throw new VtopError(
              "NOT_AUTHENTICATED",
              "VTOP session expired.",
              `${endpoint} returned 404 twice, and a known-good endpoint also failed, so the session really is dead.`,
            );
          }
          console.error(
            `VtopMCP: ${endpoint} returned 404 but the session is healthy — the endpoint path does not exist.`,
          );
          throw new VtopError(
            "ENDPOINT_NOT_FOUND",
            `VTOP has no endpoint at "${endpoint}".`,
            "HTTP 404 twice on an authenticated request, while a known-good endpoint still works. " +
              "The path is wrong or renamed; the session is fine.",
          );
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to fetch ${endpoint}: ${msg}`);
      }
    }
  }
}
