# Development

```bash
npm install
npm run build          # compile to dist/
npm run typecheck      # tsc --noEmit — the build itself does NOT typecheck
npm run test:parser    # offline parser checks (Bhopal fixtures)
npm run test:tools     # offline tool checks with a fake VTOP client
npm run test:login     # offline login handshake against a mock VTOP
npm run test:exam      # pass-rule arithmetic
npm run test:leave     # leave validation, fingerprints, exam overlap
npm run test:info      # profile/ack/proctor, baskets + pending, fees, history
npm run test:http      # HTTP connector: auth, CORS, transport, landing page
npm run test:privacy   # fixture hygiene guard
npm run test:all       # everything above, then build + HTTP suite + MCP smoke test
```

**356 offline checks.** Every suite except the `e2e` ones needs no VTOP account
and touches no network — deliberate, so the suite is safe in CI.

`npm run build` runs `tsup` only. **Run `typecheck` separately** — a build that
succeeds can still contain type errors, and that has happened.

---

## Layout

```
src/
  index.ts              stdio entry point (what you run)
  http.ts               multi-user HTTP connector (inherited, hardened, live-tested)
  server.ts             MCP server wiring, tool registration
  web.ts                landing page served by the HTTP connector
  schemas/index.ts      every tool's input schema, in one place
  tools/                one file per tool group; thin wrappers over services
  services/
    vtop-client.ts      HTTP, cookies, the prelogin handshake, endpoint calls
    vtop-parser.ts      cheerio parsing of VTOP's HTML
    leave.ts            leave validation, fingerprints, overlap checks
    exam-eligibility.ts pass arithmetic in both scales
    marks-calc.ts       internal totals
    errors.ts           structured error taxonomy
    cache.ts            bounded TTL cache
    keepalive.ts        session keepalive
    constants.ts        endpoints, leave types, limits
scripts/
  fixtures.ts           synthetic VTOP HTML
  *-test.ts             the suites above
  privacy-test.ts       the hygiene guard
```

**Tools are thin.** A tool validates input, calls a service, returns parsed
output. Business logic lives in `src/services/` where it can be tested without
an MCP server.

---

## Adding a tool

1. **Write the input schema** in `src/schemas/index.ts`. If it takes only a
   semester, reuse `SemesterInputSchema`.
2. **Put the logic in `src/services/`** as a pure function taking HTML and
   returning data. It must not touch the network.
3. **Register the tool** in the relevant `src/tools/` file via `mkJsonTool`,
   which supplies `readOnlyHint: true` by default.
4. **Add the write hint if it writes.** `readOnlyHint: false` +
   `destructiveHint` / `idempotentHint` as appropriate. **The smoke test asserts
   this**, so a new write path cannot silently inherit the read-only default and
   skip the client's permission prompt.
5. **Add tests** to the matching `scripts/*-test.ts`.
6. **Add it to `scripts/mcp-smoke.ts`** so the protocol test covers it.
7. **Document it** in [tools.md](tools.md) and the README table.

### Writing a good tool description

Descriptions are read by the model deciding whether to call your tool. Say what
it returns, what the optional arguments do, and what to do on failure. See the
existing descriptions — they carry recovery instructions like *"If the response
contains NOT_AUTHENTICATED, immediately call get_captcha then login then
retry"*, which is why recovery is reliable in practice.

---

## Fixture rules — non-negotiable

Tests may mirror the real **shape** of a VTOP response: field names, dropdown
order, column order, printed date formats. None of that can be guessed.

They must **never** carry real **values**.

`npm run test:privacy` enforces this on every text file in the repo, matching
**patterns** rather than a blocklist so a fresh leak is caught, not just a
repeat of a previous one. It fails the build on a real registration number, a
real leave id, a CSRF token, a proctor's staff id, or assigned credentials in an
env file.

Adding a new fake identifier means adding it to the `SYNTHETIC` allowlist in
`scripts/privacy-test.ts` — a deliberate extra step, not an accident.

See [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## Testing approach

**Offline by default.** Parsers take HTML strings. Services take clients. Tools
are checked against a fake `VtopClient`. Nothing needs a live account.

**The login suite starts a local mock VTOP** — TLS with a throwaway self-signed
cert generated into the temp directory, nothing written to the repo. It drives
the real `VtopClient` through the prelogin handshake, captcha retrieval, a
successful login, every failure mode, mid-session expiry, and the mapping from
each failure to its error code. Needs `openssl` on PATH. Never touches the
network.

**Property-style checks on arithmetic.** The pass-rule suite asserts things like
*"a failed and a missed CAT owe the SAME deficit"* and *"10 and 10 then a 45 FAT
still FAILS (needs 60)"* — invariants that hold across the input space, not
just the example that motivated them.

**The smoke test** starts the built server and speaks MCP to it, asserting the
tool list, the protocol handshake and the write-hint annotations.

---

## Two design decisions worth knowing

### Errors are structured, not prose

Every failure carries a machine-readable `code`, `retryable`, `needsUserInput`
and an ordered `recovery` list. Previously recovery was delegated to the model
via a long instruction in `Error.message` to "call get_captcha, then login, then
retry" — which a model can paraphrase, skip or reorder. Branching on a stable
code is the fix. Full table in [errors.md](errors.md).

### `ENDPOINT_NOT_FOUND` is separate from `NOT_AUTHENTICATED`

VTOP 404s both dead sessions and nonexistent paths. Conflating them meant a
wrong route threw away a working session and started a pointless captcha loop.
The session is now verified against a known-good endpoint before it's
condemned.

> The first attempt at this fix was **inert** — the liveness probe didn't send
> the auth fields VTOP needs, so it confirmed a dead session every time and
> reproduced the original bug exactly. It was only caught by running it live.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `VTOP_BASE_URL` | Bhopal | Point at a different VTOP deployment |
| `VTOP_USERNAME` / `VTOP_PASSWORD` | — | Credentials. Keep in `.env`, never commit |
| `VTOP_TIMEOUT_MS` | `30000` | Raise to `60000` if VTOP is slow |
| `VTOP_KEEPALIVE_MINUTES` | `5` | Session keepalive interval |
| `VTOP_SEMESTER_ID` | — | Skip the interactive semester picker |
| `VTOP_PROXY_URL` | — | Proxy, useful against `RECAPTCHA_REQUIRED` |
| `VTOP_INSECURE_TLS` | — | Disable TLS verification for VTOP connections only (Redis etc. stay verified). **Trusted networks only** |
| `CONNECTOR_SECRET` | — | Turns the HTTP connector multi-user |
| `VTOP_DUMP_HTML` | — | `1` writes raw pages to `test-output/` — **contains your data** |

See [`.env.example`](../.env.example).

---

## Known gaps

- **The HTTP connector is live-tested.** `scripts/http-test.ts` covers 20 offline checks — routing, auth, CORS, the MCP transport, the landing page and log hygiene — and a full register → captcha → login → real-data pass was run against VTOP on 13 Oct 2026. See [http-connector.md](http-connector.md).
- **`npm audit` reports 1 critical, 9 high.** All of them are in express, which
  only `http.ts` imports; `dist/index.js` - the path most users run - never loads
  them. The critical is `proxy-addr`, reachable only through `http.ts`.
  `npm audit fix` changes 20 packages and is not run automatically; doing so
  needs a full re-verification.
- **Seven of eight leave duration caps are unknown** and will stay unknown until
  VTOP publishes them.
- **The OD limit is inferred**, not confirmed.

---

## Debugging tools

Not part of `test:all`. Each exists because something specific broke and
rewriting it would have been slower. Run them from the repo root.

**Probes — these contact the live portal and need an account**

| Script | What it answers |
|---|---|
| `npm run captcha:probe` | How often does VTOP serve a readable image captcha vs Google reCAPTCHA? That ratio is what `RECAPTCHA_REQUIRED` is really about. |
| `npm run captcha:save` | Saves a live captcha to `test-output/` so it can be read by eye. |
| `node scripts/leave-probe.ts` | Discovers the hostel-leave endpoints. This is how `leave/1..4` was found — roughly fifty guessed paths under `hostel/*` all returned *"This menu is not available at present!!!"*, because VTOP was correctly reporting paths that do not exist. |
| `node scripts/login-trace.ts` | Two-phase tracer that pinpoints exactly where the login POST 404s. Defaults to Bhopal; override with `VTOP_BASE_URL`. |
| `node scripts/calendar-debug.ts` | Dumps the raw academic-calendar HTML so day-order and holiday handling can be checked. |
| `npm run test:e2e` | Full tool surface against a real account. |
| `node scripts/multiuser-e2e.ts` | Proves per-token session isolation over HTTP — one user's cached data cannot reach another. |
| `node scripts/test-published.ts` | Verifies the **published npm package** works when installed. Inert until we actually publish; the package is currently `private`. |

**Raw inspection**

```bash
npm run raw:call                                    # defaults to get_attendance
npm run raw:call -- get_marks '{"semesterId":"BL20252605"}'
```

`raw:call` prints the complete `CallToolResult` — the whole payload the server
sends, including `structuredContent` — rather than the summary an assistant
would see. That gap is where a surprising number of bugs hide.

**How to use them**

1. Reproduce the failure through a normal tool call.
2. Pick the probe that isolates that layer — parser, calendar, captcha or
   login.
3. Read its raw output rather than trusting the parsed result. Half the
   Bhopal-specific bugs were invisible in the parsed form and obvious in the
   markup.
4. **Never commit what they write.** `test-output/`, `tmp-caldebug/` and
   `tmp-leaveprobe/` all contain session-bearing HTML and are gitignored for
   that reason.

---

## Related

- [tools.md](tools.md) · [errors.md](errors.md) · [bhopal-vtop.md](bhopal-vtop.md)
- [CONTRIBUTING.md](../CONTRIBUTING.md)
