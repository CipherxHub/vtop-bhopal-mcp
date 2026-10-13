# HTTP connector

`src/http.ts` serves the same 23 tools as the stdio server, but over
**Streamable HTTP** so a remote MCP client can reach them. That is what makes
the hosted and mobile options possible: Claude's connector model requires a
server reachable over the internet, and a local stdio process cannot be.

```bash
npm run build
npm run start:http      # listens on 127.0.0.1:3000 by default
```

---

## What is tested, and what is not

Being precise about this, because it determines how much you should trust it.

**Tested offline — 18 checks in `scripts/http-test.ts`:**

| | |
|---|---|
| Lifecycle | `/healthz`, `/`, `/robots.txt`, `/sitemap.xml`, `/og.svg` |
| Auth | tokenless `GET` and `POST /mcp` → 401; garbage token → 401; `/register` → 503 without a secret |
| Auth regression | `CONNECTOR_SECRET` + env credentials + no token → **401** |
| Protocol | `initialize` → `mcp-session-id` → `tools/list` → 23 tools with correct `readOnlyHint` flags |
| Transport | response `Content-Type` is `application/json`, **not** `text/event-stream` |
| CORS | an `Origin` header gets no `Access-Control-Allow-Origin` by default |
| Landing page | client-neutral, no phantom npm install, never echoes the password |
| Logging | the connector token never reaches stdout/stderr |

**Not yet tested: a real login over HTTP.** The suites never contact VTOP — the
server only dials out when a tool is called, and these only exercise routing,
auth and the MCP handshake. The VTOP-facing half of this path (captcha →
login → a real fetch, over HTTP rather than stdio) has **not** been exercised
against the live portal.

That caveat stays until it has been. It is the single most likely thing to
behave differently from the stdio path, because the cookie jar has to survive
between `get_captcha` and `login` across what may be separate MCP sessions.

---

## The security model

**Your password is encrypted into the link, and nothing is stored.**

```
you type  {"username":"…","password":"…"}
          ↓ AES-256-GCM, key = scrypt(CONNECTOR_SECRET)
token     Xt9kQ2mB7pL4nR8vZ1sF6hJ3wD0yG5cA8eU2iO4nM7qR1tY0
          ↓ the plaintext is never written anywhere
```

Each person gets their own token, so each gets their own login. Per-token
isolation means one person's cached attendance can never reach another — the
caches live inside that person's client instance, not in a shared pool.

### The four properties that matter

1. **`CONNECTOR_SECRET` is the crown jewel.** Every token is encrypted with it.
   If it leaks, someone can decrypt **all** tokens and read **everyone's** VTOP
   passwords. Keep it out of the repo, screenshots and logs.
2. **Auth fails closed.** With `CONNECTOR_SECRET` set, a valid token is required
   — *unconditionally*, even when `VTOP_USERNAME`/`VTOP_PASSWORD` are also set.
   This was not true before: the documented setup (a `.env` with credentials)
   plus `CONNECTOR_SECRET` used to serve `/mcp` to anyone holding the URL, with
   no token and no warning. Setting a secret now means what it says.
3. **No token in logs.** There is no access logger, session keys are stored
   hashed (`sha256(...).slice(0, 40)`), and nothing echoes `req.url`. If you add
   `morgan` or similar, you are adding a token leak — redact the path.
4. **Rotating is all-or-nothing.** Changing `CONNECTOR_SECRET` invalidates every
   link at once, and there is no way to revoke one person alone. That is the
   cost of not having a database.

---

## Deploying it safely

### On your own machine, behind a tunnel

```bash
# Generate a secret once and keep it somewhere safe
export CONNECTOR_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# Do NOT set VTOP_USERNAME / VTOP_PASSWORD here — see the warning below
npm run start:http
cloudflared tunnel --url http://127.0.0.1:3000
```

Then `POST /register` to get a link, and add it to your client.

> **Use `127.0.0.1`, not `localhost`.** On systems where `localhost` resolves to
> `::1` first, a server bound only to IPv4 refuses the connection and the
> tunnel reports a 502 that looks like a server fault.

### On a hosting platform

The same code works on Render, Railway or Replit — `render.yaml` and a
`Dockerfile` ship with the repo. Three changes:

```bash
VTOP_HTTP_BIND=0.0.0.0     # platforms route in from outside
CONNECTOR_SECRET=<32+ random chars>
REDIS_URL=redis://…        # optional but see below
```

**Redis matters more than it looks.** Sessions live in memory, so a platform
that spins down after idle wipes the cookie jar and the next request needs a
fresh captcha. With `REDIS_URL` set, sessions are persisted (encrypted, keyed by
`CONNECTOR_SECRET`) and rehydrated on wake — skipping the captcha entirely, as
long as VTOP still accepts the session.

Free tiers sleep after roughly 15 minutes; VTOP's idle timeout is roughly 20.
The sleep is shorter than the timeout, so a persisted session can usually
survive the gap. That is the difference between "a captcha every few minutes"
and "a captcha occasionally".

### The datacenter-IP caveat

VTOP escalates to a **Google reCAPTCHA** — which this server cannot read — when
a login looks like it comes from a datacentre. A home connection does not trip
that; a hosting platform usually will.

This is why the laptop-and-tunnel option is preferable where it is viable, and
why a hosted deployment should be tested with one real login before you point
anyone else at it.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CONNECTOR_SECRET` | — | Enables multi-user tokens. ≥16 chars. **Required for any public deployment.** |
| `VTOP_HTTP_BIND` | `127.0.0.1` | Interface to bind. Set `0.0.0.0` only for PaaS or a non-loopback tunnel |
| `VTOP_HTTP_CORS_ORIGIN` | *(empty)* | Comma-separated CORS allowlist. Empty = no CORS headers at all |
| `MCP_PATH` | `/mcp` | Endpoint path |
| `PORT` | `3000` | |
| `REDIS_URL` | — | Cross-restart session persistence. Needs `CONNECTOR_SECRET` |
| `STATS_TOKEN` | — | Enables the operator dashboard at `/stats/<token>`; without it that route 404s |
| `KEEPALIVE_TOKEN` | — | Enables `/keepalive/<token>` for an external cron |
| `SESSION_KEEPALIVE_MS` | `0` (off) | In-process keepalive sweep |

### Why CORS is off by default

The connector calls this server **from Anthropic's cloud**, not from a browser,
so it sends no `Origin` header and needs no CORS. Reflecting whatever `Origin`
arrives — the previous behaviour — let any website the operator visited make
cross-origin calls to the server, which in env-credential mode is a drive-by
path to the VTOP session.

The browser-based MCP Inspector *does* need it:

```bash
VTOP_HTTP_CORS_ORIGIN=http://localhost:6274 npx @modelcontextprotocol/inspector
```

### Why the bind defaults to loopback

So the port is not reachable from your home network by default. A tunnel on the
same machine connects over loopback and is unaffected. `0.0.0.0` is a
deliberate act, and the server logs a warning when you do it.

---

## Rotating a leaked link

1. Change `CONNECTOR_SECRET` to a new random value and restart.
2. Every existing link now fails with `401`.
3. Everyone re-registers at `/register` and replaces their connector URL.

There is no partial rotation. That is inherent to the no-database design.

---

## Related

- [tools.md](tools.md) · [errors.md](errors.md) · [development.md](development.md)
- [../CONTRIBUTING.md](../CONTRIBUTING.md)
