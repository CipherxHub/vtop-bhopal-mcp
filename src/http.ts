import { randomUUID, createHash } from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server.js";
import { VtopClient, type VtopSession } from "./services/vtop-client.js";
import type { Credentials } from "./types/index.js";
import {
  decryptCredentials,
  encryptCredentials,
  encryptString,
  decryptString,
  isMultiUserEnabled,
} from "./services/crypto.js";
import { getSessionStore } from "./services/session-store.js";
import { pMap } from "./services/concurrency.js";
import {
  landingPage,
  resultPage,
  unavailablePage,
  ogImageSvg,
  robotsTxt,
  sitemapXml,
  statsPage,
  CHATGPT_CONNECTORS_URL,
  CHATGPT_OPEN_PATH,
} from "./web.js";

const PORT = Number(process.env.PORT ?? 3000);
const MCP_PATH = process.env.MCP_PATH ?? "/mcp";

// One transport per active MCP session. Each session gets its own MCP server
// instance, but the underlying VtopClient is shared per user (see below).
const transports: Record<string, StreamableHTTPServerTransport> = {};

// PER-USER ISOLATION. Each connector token gets its OWN VtopClient — its own
// cookie jar, login state, and caches (attendance/grades/timetable/calendar all
// live as private fields on that instance, never module-level). So no user's
// cached data can ever reach another user; parallel users are fully independent.
// Keyed by token (not by MCP session) on purpose: ChatGPT's connector may open a
// fresh MCP session per tool call, so get_captcha and login can land on different
// sessions — login must reuse the exact VtopClient get_captcha armed, else VTOP
// 404s. Single-user mode (env creds, no token) has just one shared client.
//
// Bounded by both idle TTL and a hard max (LRU) so memory stays in check under
// many users — Node is single-threaded, so Map access here is race-free.
const SINGLE_USER_KEY = "__single_user__";
const CLIENT_TTL_MS = 30 * 60 * 1000; // evict idle clients from memory after 30 min
const MAX_CLIENTS = 500; // hard cap; evict least-recently-used beyond this
const clientsByUser = new Map<string, { client: VtopClient; lastUsed: number }>();

// Optional cross-restart persistence (enabled by REDIS_URL). When set, an
// authenticated session is also written here (encrypted), so a fresh process
// after a redeploy / free-tier spin-down can rehydrate it and skip the
// captcha+login — as long as VTOP still considers the session valid. Without
// REDIS_URL this is null and behaviour is exactly as before (memory only).
const sessionStore = getSessionStore();
// How long a persisted blob lives before it self-expires. Sessions die at
// VTOP's own idle timeout well before this; the TTL just bounds dead entries.
const SESSION_PERSIST_TTL_SEC = Number(process.env.SESSION_PERSIST_TTL_SEC ?? 2 * 60 * 60);
// Optional keepalive: every N ms, touch VTOP for each live session so its
// server-side timer doesn't idle out (and refresh the persisted copy). Off by
// default (0); only useful on an always-on / kept-warm host. Suggest ~600000.
const KEEPALIVE_MS = Number(process.env.SESSION_KEEPALIVE_MS ?? 0);
// Secret that gates the usage-stats dashboard. The dashboard lives at the
// unguessable path /stats/<STATS_TOKEN>; without this set the route is disabled
// (404), and any wrong token also 404s, so the page is invisible to the public.
const STATS_TOKEN = process.env.STATS_TOKEN?.trim();
// Secret that gates the keepalive sweep at /keepalive/<KEEPALIVE_TOKEN>. Point an
// external cron at that URL every ~10 min: the request both wakes a spun-down
// dyno AND warms every persisted VTOP session (pinging VTOP resets its idle
// timeout), so sessions survive for as long as the cron runs — not just 30 min.
const KEEPALIVE_TOKEN = process.env.KEEPALIVE_TOKEN?.trim();

/** Storage key for a token — hashed so the raw token never lands in the store. */
function sessionKey(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 40);
}

/**
 * Wire a client's persistence hooks to the store. Requires CONNECTOR_SECRET
 * (multi-user mode) since blobs are encrypted with it; no-op otherwise.
 */
function attachPersistence(key: string, client: VtopClient): void {
  if (!sessionStore || !isMultiUserEnabled()) return;
  const skey = sessionKey(key);
  client.onSessionPersist = () => {
    try {
      const blob = encryptString(JSON.stringify(client.exportSession()));
      void sessionStore
        .set(skey, blob, SESSION_PERSIST_TTL_SEC)
        .then(() =>
          console.error(
            `VtopMCP: session saved to Redis (key ${skey.slice(0, 8)}…, ttl ${SESSION_PERSIST_TTL_SEC}s).`,
          ),
        )
        .catch((e) =>
          console.error("VtopMCP: session persist failed:", e instanceof Error ? e.message : e),
        );
    } catch (e) {
      console.error("VtopMCP: session encrypt failed:", e instanceof Error ? e.message : e);
    }
  };
  client.onSessionClear = () => {
    void sessionStore
      .delete(skey)
      .then(() => console.error(`VtopMCP: session cleared from Redis (key ${skey.slice(0, 8)}…).`))
      .catch((e) => console.error("VtopMCP: session clear failed:", e instanceof Error ? e.message : e));
  };
}

async function getSharedClient(key: string): Promise<VtopClient> {
  const now = Date.now();
  // Idle eviction.
  for (const [k, entry] of clientsByUser) {
    if (now - entry.lastUsed > CLIENT_TTL_MS) clientsByUser.delete(k);
  }
  const existing = clientsByUser.get(key);
  if (existing) {
    existing.lastUsed = now;
    // Move to most-recently-used end (Map keeps insertion order → O(1) LRU).
    clientsByUser.delete(key);
    clientsByUser.set(key, existing);
    return existing.client;
  }
  // Hard cap: drop the least-recently-used (the first entry) before inserting.
  if (clientsByUser.size >= MAX_CLIENTS) {
    const lru = clientsByUser.keys().next().value;
    if (lru !== undefined) clientsByUser.delete(lru);
  }
  const client = new VtopClient();
  attachPersistence(key, client);
  // Record usage stats on login (by registration number). Fire-and-forget so it
  // never delays login. Works whenever a store is configured.
  if (sessionStore) {
    client.onLogin = (regNo) => {
      void sessionStore.recordUser(regNo, "login").catch((e) =>
        console.error("VtopMCP: stats record failed:", e instanceof Error ? e.message : e),
      );
    };
  }
  // Cold miss: try to restore a persisted session so the user skips re-login.
  if (sessionStore && isMultiUserEnabled()) {
    try {
      const blob = await sessionStore.get(sessionKey(key));
      if (blob) {
        const session = JSON.parse(decryptString(blob)) as VtopSession;
        client.importSession(session);
        console.error("VtopMCP: resumed a persisted session from the store (no re-login needed if VTOP still accepts it).");
        // Count the active user even though they didn't freshly log in. The reg
        // number is right here in the restored blob — fire-and-forget, no delay.
        if (session.authorizedID) {
          void sessionStore.recordUser(session.authorizedID, "reuse").catch((e) =>
            console.error("VtopMCP: stats reuse-record failed:", e instanceof Error ? e.message : e),
          );
        }
      }
    } catch (e) {
      console.error("VtopMCP: session restore failed:", e instanceof Error ? e.message : e);
    }
  }
  clientsByUser.set(key, { client, lastUsed: now });
  return client;
}

// Keepalive loop (opt-in). Touch each live session; if VTOP has dropped one,
// evict it from memory so the next request does a clean re-login.
if (KEEPALIVE_MS > 0) {
  setInterval(() => {
    void (async () => {
      for (const [k, entry] of clientsByUser) {
        if (!entry.client.isAuthenticated) continue;
        try {
          await entry.client.keepAlive();
        } catch {
          /* ignore */
        }
        if (!entry.client.isAuthenticated) clientsByUser.delete(k);
      }
    })();
  }, KEEPALIVE_MS).unref();
}

const app = express();
// Render (and most PaaS) terminate TLS at a proxy; trust it so req.protocol is
// "https" and req.get("host") is the public hostname when we build connector URLs.
app.set("trust proxy", true);
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: false }));

// CORS so the browser-based MCP Inspector can reach the server. ChatGPT
// itself connects server-side and does not need this.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, mcp-protocol-version, authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

function originOf(req: Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

// Cheap, always-200 endpoint for uptime pingers / keep-warm cron jobs. Unlike
// /mcp (which is the MCP protocol endpoint and returns 401/400 to a bare GET),
// this just confirms the process is up — point your keep-warm cron here.
app.get("/healthz", (_req, res) => {
  res.type("text/plain").set("Cache-Control", "no-store").send("ok");
});

// Bounce the "Connect to ChatGPT" button to ChatGPT via a server redirect.
// Going through our own (non-app-associated) domain stops mobile OSes from
// hijacking the chatgpt.com link into the ChatGPT app — universal-/app-links
// fire on the initial tap, not on a 302 — so it opens in the browser tab.
app.get(CHATGPT_OPEN_PATH, (_req, res) => {
  res.redirect(302, CHATGPT_CONNECTORS_URL);
});

// Keepalive sweep: an external cron hits /keepalive/<KEEPALIVE_TOKEN> every
// ~10 min. The request wakes a spun-down dyno AND pings VTOP for every persisted
// session (resetting VTOP's idle timeout) so sessions stay alive for as long as
// the cron runs — instead of dying after 30 min. Token in the path = the secret;
// wrong/missing token (or no KEEPALIVE_TOKEN) → 404.
app.get("/keepalive/:token", async (req: Request, res: Response) => {
  if (!KEEPALIVE_TOKEN || req.params.token !== KEEPALIVE_TOKEN) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  if (!sessionStore) {
    res.status(200).json({ checked: 0, kept: 0, dropped: 0, note: "no REDIS_URL" });
    return;
  }
  let kept = 0;
  let dropped = 0;
  try {
    const sessions = await sessionStore.listSessions();
    await pMap(
      sessions,
      async ({ key, blob }) => {
        try {
          const client = new VtopClient();
          client.importSession(JSON.parse(decryptString(blob)) as VtopSession);
          if (await client.keepAlive()) {
            // Re-save the (possibly refreshed) session and bump its TTL.
            await sessionStore!.set(
              key,
              encryptString(JSON.stringify(client.exportSession())),
              SESSION_PERSIST_TTL_SEC,
            );
            kept++;
          } else {
            await sessionStore!.delete(key); // VTOP dropped it — stop tracking
            dropped++;
          }
        } catch {
          dropped++;
        }
      },
      5,
    );
    console.error(`VtopMCP: keepalive sweep — ${kept} kept warm, ${dropped} dropped.`);
    res.status(200).set("Cache-Control", "no-store").json({ checked: sessions.length, kept, dropped });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Secret usage-stats dashboard at /stats/<STATS_TOKEN>. Token is in the path,
// so the route itself is the secret; a wrong token (or no STATS_TOKEN set) 404s
// so the page is indistinguishable from a non-existent route. Not linked, not
// in robots/sitemap.
app.get("/stats/:token", async (req: Request, res: Response) => {
  if (!STATS_TOKEN || req.params.token !== STATS_TOKEN) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  if (!sessionStore) {
    res
      .status(200)
      .type("html")
      .send(statsPage([], "Stats require REDIS_URL (no store configured)."));
    return;
  }
  try {
    const users = await sessionStore.listUsers();
    res.status(200).set("Cache-Control", "no-store").type("html").send(statsPage(users));
  } catch (e) {
    res
      .status(500)
      .type("text/plain")
      .send(`Stats error: ${e instanceof Error ? e.message : e}`);
  }
});

app.get("/", (req, res) => {
  // In multi-user mode the root is the landing/registration experience; in
  // single-user mode it stays a small JSON info endpoint. Both return 200 so
  // Render's health check (healthCheckPath: /) passes either way.
  if (isMultiUserEnabled()) {
    res.type("html").send(landingPage(originOf(req), "/"));
    return;
  }
  res.json({
    name: "vtop-mcp",
    transport: "streamable-http",
    endpoint: MCP_PATH,
    multiUser: false,
  });
});

app.get("/og.svg", (_req, res) => {
  res.type("image/svg+xml").set("Cache-Control", "public, max-age=86400").send(ogImageSvg());
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(robotsTxt(originOf(req)));
});

app.get("/sitemap.xml", (req, res) => {
  res.type("application/xml").send(sitemapXml(originOf(req)));
});

function extractToken(req: Request): string | undefined {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }
  // URL-path token: lets ChatGPT use a per-user connector URL with "No Auth",
  // since its connector UI offers no API-key / header field.
  const pathToken = req.params?.token;
  if (typeof pathToken === "string" && pathToken.trim()) {
    return pathToken.trim();
  }
  const x = req.headers["x-vtop-token"];
  if (typeof x === "string" && x.trim()) return x.trim();
  return undefined;
}

function send401(res: Response, message: string) {
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message },
    id: null,
  });
}

/**
 * Resolve the VTOP credentials for a request.
 *  - A valid connector token (multi-user mode) yields that user's credentials.
 *  - No token is allowed only when the server isn't enforcing multi-user, i.e.
 *    single-user env-var credentials or the legacy in-chat login flow.
 * Returns null after sending a 401 when authentication is required but absent.
 */
function authenticate(
  req: Request,
  res: Response,
): { credentials?: Credentials } | null {
  const token = extractToken(req);
  if (token) {
    try {
      return { credentials: decryptCredentials(token) };
    } catch {
      send401(res, "Invalid connector token. Re-register at /register to get a new one.");
      return null;
    }
  }
  const hasEnvCreds = !!(process.env.VTOP_USERNAME && process.env.VTOP_PASSWORD);
  if (isMultiUserEnabled() && !hasEnvCreds) {
    send401(res, "Authentication required. Visit /register to create your personal connector token.");
    return null;
  }
  return {};
}

async function handleMcpPost(req: Request, res: Response) {
  const auth = authenticate(req, res);
  if (!auth) return;

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };

    // Reuse this user's VtopClient across MCP sessions so the prelogin session
    // armed by get_captcha is the same one login submits to. Keyed by token in
    // multi-user mode (per-user isolation) or a single key otherwise.
    const client = await getSharedClient(extractToken(req) ?? SINGLE_USER_KEY);

    // Bind the authenticated user's credentials to this session's server.
    const { server } = createServer(auth.credentials, client);
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID provided" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
}

// GET = server-to-client SSE stream; DELETE = explicit session teardown.
async function handleSessionRequest(req: Request, res: Response) {
  if (!authenticate(req, res)) return;
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
}

// Each method is mounted twice: the bare path (header / single-user clients)
// and a token-in-path variant (`/mcp/<token>`) for ChatGPT's "No Auth" mode.
app.post(MCP_PATH, handleMcpPost);
app.post(`${MCP_PATH}/:token`, handleMcpPost);
app.get(MCP_PATH, handleSessionRequest);
app.get(`${MCP_PATH}/:token`, handleSessionRequest);
app.delete(MCP_PATH, handleSessionRequest);
app.delete(`${MCP_PATH}/:token`, handleSessionRequest);

// --- Self-service registration (multi-user mode) ---------------------------
// Each user submits their own VTOP credentials here and receives a personal
// connector link with their credentials encrypted into the URL. Nothing is
// stored on the server.

app.get("/register", (req: Request, res: Response) => {
  if (!isMultiUserEnabled()) {
    res
      .status(503)
      .type("html")
      .send(
        unavailablePage(
          originOf(req),
          "This server is running in single-user mode. Set a CONNECTOR_SECRET environment variable to enable per-user connector links.",
        ),
      );
    return;
  }
  res.type("html").send(landingPage(originOf(req), "/"));
});

app.post("/register", (req: Request, res: Response) => {
  if (!isMultiUserEnabled()) {
    res
      .status(503)
      .type("html")
      .send(unavailablePage(originOf(req), "Set CONNECTOR_SECRET to enable registration."));
    return;
  }
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!username || !password) {
    res
      .status(400)
      .type("html")
      .send(unavailablePage(originOf(req), "Both username and password are required. Go back and try again."));
    return;
  }
  const token = encryptCredentials({ username, password });
  const origin = originOf(req);
  res
    .set("Cache-Control", "no-store")
    .type("html")
    .send(
      resultPage({
        origin,
        connectorUrl: `${origin}${MCP_PATH}/${token}`,
        baseMcpUrl: `${origin}${MCP_PATH}`,
        token,
      }),
    );
});

app.listen(PORT, () => {
  console.error(`VtopMCP HTTP server listening on :${PORT}${MCP_PATH}`);
  if (isMultiUserEnabled()) {
    console.error(`Multi-user mode ON — users register at :${PORT}/register`);
  }
  if (sessionStore && !isMultiUserEnabled()) {
    console.error(
      "VtopMCP: REDIS_URL is set but CONNECTOR_SECRET is not — session persistence is disabled (it needs the secret to encrypt blobs).",
    );
  }
  // Verify Redis is actually reachable at startup so a misconfigured REDIS_URL
  // is obvious immediately (rather than silently failing on the first login).
  if (sessionStore && isMultiUserEnabled()) {
    void sessionStore
      .get("__startup_check__")
      .then(() => console.error("VtopMCP: Redis session store reachable — persistence active."))
      .catch((e) =>
        console.error(
          "VtopMCP: Redis session store UNREACHABLE:",
          e instanceof Error ? e.message : e,
          "— check REDIS_URL. Upstash needs the rediss:// scheme (TLS), e.g. rediss://default:<password>@<host>:6379",
        ),
      );
  }
  if (KEEPALIVE_MS > 0) {
    console.error(`VtopMCP: in-process session keepalive ON (every ${Math.round(KEEPALIVE_MS / 1000)}s).`);
  }
  if (KEEPALIVE_TOKEN && sessionStore) {
    console.error("VtopMCP: keepalive sweep ON — point a cron at /keepalive/<token> every ~10 min to keep sessions warm.");
  }
});
