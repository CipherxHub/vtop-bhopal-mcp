# Changelog

Notable changes to **vtop-bhopal-mcp** are documented here. This project
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Hostel leave tools.** get_leave_types, get_leave_status,
  pply_leave and the get_leave_type_rules diagnostic. Leave types are read
  from VTOP's live dropdown rather than hard-coded.
- **Pass eligibility.** check_pass_eligibility reports what you must score to
  pass, in both the raw-on-paper scale and the weighted 100-point scale, plus
  which classes or exams a proposed leave would cost you.
- **Internal mark totals.** get_internal_totals reports marks banked per
  course with every component still outstanding.
- **Structured errors.** 13 stable error codes with ordered recovery plans, so
  a client branches on error.code instead of parsing English.
- **HTTP connector tests.** 19 offline checks covering routing, auth, CORS, the
  MCP transport, the landing page and token log-hygiene.

### Fixed
- **Sessions before a deadline were always counted as zero.**
  sessionsBefore tested if (weekday && ...), and dayOrderWeekday is null
  on an ordinary day, so normal weekdays never counted. It now falls back to
  the natural weekday.
- **Classes before departure were reported missed on multi-day leaves.**
  indClassOverlaps computed wholeDay as rom !== to || (...), true for
  every multi-day leave, which made the boundary guards unreachable. Boundary
  days now keep their time filtering.
- **pply_leave reported SUBMITTED even when VTOP rejected the request.** It
  now distinguishes submitted, rejected, and an unclear response with no new
  record - never claiming success on silence.
- **pply_leave ran every VTOP fetch before checking the preview token.** A
  bogus token on confirm=true cost several upstream requests; it is now
  rejected before any request is made.
- **HTTP 404 no longer ends a healthy session.** A wrong route was reported as
  a dead session, throwing away a good login and starting a pointless captcha
  loop.
- **VTOP's HTTP-200 failure pages no longer parse as empty data.** "Menu not
  available" and "unable to process" are now distinct errors.

### Security
- **pply_leave confirmation is a server-signed single-use token**, bound to a
  SHA-256 digest of the exact field values, expiring after 10 minutes. The old
  FNV-1a fingerprint was client-computable, so it could not prove a preview had
  been shown.
- **Authentication fails closed.** With CONNECTOR_SECRET set, a valid token is
  required unconditionally - previously env credentials satisfied the check, so
  a .env plus a secret served /mcp to anyone holding the URL.
- **MCP sessions are bound to their caller's token**, compared in constant time,
  so knowing a session id is no longer enough to drive it.
- **Connector tokens expire** (90 days by default), bounding the damage from a
  leaked URL. Legacy tokens keep working until a sunset date.
- **CORS is off by default** behind an explicit allowlist. It previously
  reflected any Origin, letting any visited website call the server.
- **The HTTP connector binds loopback and trusts only the loopback proxy**, so
  it is not reachable from the local network and X-Forwarded-* cannot be
  forged.

### Changed
- Responses are plain JSON rather than an SSE stream, so tool calls work through
  Cloudflare Quick Tunnels. The optional server-initiated GET stream is gone;
  a tool-only server never used it.
- The landing page covers every MCP client rather than ChatGPT alone, and the
  registration field enforces the real registration-number shape as you type.

### Known limitations
- Connector tokens live in a URL. Expiry bounds the exposure; eliminating it
  needs opaque server-side tokens and a store.
- The preview-token nonce set is in-process, so a restart invalidates outstanding
  previews and a multi-replica deployment cannot confirm across replicas.
- VTOP appears to drop connections from datacentre IP ranges, so the HTTP
  connector only works from a residential connection.

---

## Inherited changelog

The entries below are the changelog of [VtopMCP](https://github.com/Vikranth-jagdish/VtopMCP)
by Vikranth Jagdish, retained because that code is still part of this
repository. It documents @vikranth2005/vtop-mcp, a different package.
## [Unreleased]

### Fixed
- **OD hours undercounted on 12-hour (AM/PM) timings.** `calculate_od` derives a
  class's period count from its "Day And Timing" cell. The old parser only read
  24-hour `HH:MM` times, so a 12-hour entry whose span crossed noon
  (e.g. an `11:00 AM - 01:40 PM` lab) computed a negative duration and silently
  fell back to one period â€” undercounting OD hours. Both clock tokens are now
  parsed with their own AM/PM, and a noon-crossing span is corrected.
- **Grade history could return empty/garbled data ("didn't parse").**
  `parseGradeHistory` relied on fixed column positions, an exact `tableContent`
  class, and an 8-column row. Any VTOP layout change (reordered/added columns,
  renamed class) made it silently return nothing or mis-mapped fields. Columns
  are now detected by content (course code, grade letter, credits, exam month),
  with a fallback that scans every row when `tableContent` is absent.
- **Transient bad grade page no longer poisons the session.**
  `getGradeHistoryHtml` cached the first response for the whole session; an
  occasional empty/error shell (still HTTP 200) would make every grade and
  curriculum call fail until logout. Only pages that actually carry grade
  content (a CGPA value or a course code) are cached now.

### Added
- **`calculate_gpa` tool â€” GPA / CGPA calculator** (VIT 10-point scale). Reports
  current CGPA, percentage (CGPAÃ—10), and each completed semester's GPA (computed
  from grades), computes the GPA of a provided set of grades, projects your CGPA,
  and works out the GPA needed to reach a target CGPA.
- **`predict_grades` â€” CGPA grade predictor (implemented but currently INACTIVE,
  not registered as a tool).** Estimates grades from current marks (absolute for
  lab/soft-skill/project, relative for theory using a user-supplied class
  average). Kept in the codebase (`src/tools/predict-grades.ts`) but disabled for
  now because reliable theory prediction needs the class average VTOP hides;
  re-enable by registering it in `src/server.ts`.
- **`calculate_od` tool â€” On-Duty hours calculator.** Totals OD hours per course
  and for the semester from the per-class attendance detail, against VIT's
  40-hour limit (reports total, per-course, and hours remaining).
- **`calculate_attendance` tool â€” attendance / bunk calculator.** Per course:
  current %, whether you're safe, how many classes you can still skip
  (`bunkBuffer`) or must attend to recover (`classesToRecover`). You're allowed
  only when attendance is STRICTLY above 74.0% (74.0 = debarred, 74.001 = safe);
  overridable via `targetPercent`. With an `untilDate`
  (e.g. a CAT attendance-closing date) it projects every real class from today
  to that date using the timetable grid + academic calendar (holidays, working
  Saturdays / day-orders) and reports how many upcoming classes you can miss or
  must attend to be safe by the deadline. Pass `bunkDates` (e.g. today) to ask
  directly "if I skip these days and attend the rest, am I still safe by the
  closing date?" â€” returns a per-course `plannedBunk` (final % + safe/not).
- **`get_today_classes` tool.** Today's (or any date's) classes with time and
  venue, calendar-aware â€” returns a holiday result on non-instructional days and
  follows the correct day-order on working Saturdays.
- **`get_calendar` tool â€” academic-calendar lookup.** Find holidays, events
  (e.g. TechnoVIT), working Saturdays / day-orders, and instructional days.
  Search a named event with `query`, list a `month`, or get `holidaysOnly`;
  `parseAcademicCalendar` now also captures each day's event/holiday label.
- **Academic calendar + timetable-grid parsing.** New `VtopClient.getCalendar`
  (3-step `CalendarPreview` â†’ `getListForSemester` â†’ `processViewCalendar` flow,
  cached per session) and `parseAcademicCalendar` / `parseTimetableGrid` parsers.
- **Optional outbound proxy (`VTOP_PROXY_URL`).** Routes VTOP traffic through an
  HTTP(S) proxy (falls back to `HTTPS_PROXY`). Useful on a datacenter/cloud host,
  where VTOP's risk score tends to serve the unreadable Google reCAPTCHA instead
  of the OCR-able image captcha â€” a residential/mobile proxy lowers the score.
- **ChatGPT connector support.** New `vtop-mcp-http` entrypoint (`src/http.ts`)
  serves the same 17 tools over the MCP **Streamable HTTP** transport so the
  server can be deployed remotely and added as a custom ChatGPT connector.
  Each MCP session gets its own server instance and `VtopClient` (isolated
  cookie jar), so concurrent remote users never share login state.
- `Dockerfile`, `.dockerignore`, and a Render blueprint (`render.yaml`) for
  one-click deployment to a public HTTPS URL.
- `npm run start:http` script and `express` dependency for the HTTP server.
- **Multi-user mode for the HTTP connector.** Setting a `CONNECTOR_SECRET` env
  var turns one shared deployment into a multi-user one without anyone typing a
  password into chat (which ChatGPT's safety layer blocks). Users self-register
  at `GET/POST /register` and receive a personal connector link
  (`https://<host>/mcp/<token>`) where `<token>` is their VTOP credentials
  encrypted with AES-256-GCM (`src/services/crypto.ts`). They add that URL in
  ChatGPT with **No Auth** â€” ChatGPT's connector UI has no API-key field, so the
  token travels in the URL path. The `/mcp/:token` route (and `Authorization:
  Bearer <token>` for header-capable clients like Claude Desktop / Cursor)
  authenticates the request and binds the decrypted credentials to that MCP
  session. Stateless â€” nothing is stored server-side, so no database is
  required. Rotating `CONNECTOR_SECRET` revokes all links. When
  `CONNECTOR_SECRET` is unset the server stays single-user and backward
  compatible (no token required).
- **Polished registration web page** (`src/web.ts`). The multi-user landing /
  registration page is a hand-designed, responsive, server-rendered experience
  with an editorial aesthetic â€” warm paper, a serif display face (Instrument
  Serif) paired with Inter and JetBrains Mono, hairline rules instead of
  shadows, a single restrained accent, subtle grain texture, dark-mode support,
  password show/hide, and one-click copy of the generated link. In multi-user
  mode `GET /` serves this landing page; it credits and links the author's
  portfolio. SEO essentials are included: semantic markup, meta
  description/keywords, canonical URL, Open Graph + Twitter cards, JSON-LD
  structured data, `/robots.txt`, `/sitemap.xml`, and a generated `/og.svg`
  social image. The post-submit result page is `noindex` + `no-store` so
  connector links never leak into caches or search engines. No new dependencies
  and no client-side framework â€” kept server-rendered for instant loads and
  crawlability.

### Performance
- **Parallelized the slow multi-request tools.** `calculate_od` fetched each
  course's attendance detail sequentially (~9 round trips) and the academic
  calendar fetched months one by one â€” both now run with bounded concurrency
  (`src/services/concurrency.ts`), and the semester auto-detect probes its
  candidate timetables concurrently instead of in series. Timetable HTML is
  cached per semester (it's static) so `calculate_attendance` / `get_today_classes`
  don't refetch it.
- **Read-only tools now carry `readOnlyHint` annotations**, so MCP clients can
  streamline / auto-approve them (login, logout and get_captcha stay unmarked
  since they change session state).
- **Multi-user isolation hardened.** All caches are per-`VtopClient` (per connector
  token) private fields â€” never module-level â€” so parallel users never share data.
  The per-token client pool is now bounded by both idle TTL and a hard LRU cap to
  keep memory steady under many users.

### Fixed
- **`get_marks` returned "not available" even when marks were published.**
  `parseMarks` treated `#fixedTableContainer` (a `<div>`) as the marks table, so
  it found no rows. It now selects the wrapped `table`, walks the course/marks
  row pairs correctly, and populates course code/name (previously left blank).
- **Multi-user login 404.** `POST /vtop/login` returned a Tomcat 404 because
  ChatGPT's connector can open a fresh MCP session per tool call, so `login` ran
  on a different, unarmed `VtopClient` than `get_captcha`. The HTTP layer now
  shares one `VtopClient` per connector token across MCP sessions.
- **TLS "unable to verify the first certificate" against VTOP.** Node ignores
  the operating-system trust store, so deployments behind a TLS-inspecting
  proxy (common on campus networks, and the remote ChatGPT-connector host)
  failed to verify VTOP's certificate chain. The server now merges the OS trust
  store into Node's default CA list at startup (`src/services/tls.ts`, invoked
  from the `VtopClient` constructor so both the stdio and HTTP entrypoints are
  covered). Requires Node >= 22.15 for the runtime CA APIs; on older runtimes
  it is a no-op and trust falls back to `NODE_EXTRA_CA_CERTS`.
- Added an opt-in `VTOP_INSECURE_TLS=1` escape hatch for hosts whose proxy CA
  isn't installed in the OS trust store. It disables certificate verification
  process-wide, so it should only be used on a trusted network.

## [0.1.5] - 2026-05-19

### Changed
- When credentials aren't configured, the assistant now asks for them in
  one short line ("What's your VTOP username and password?") instead of
  dumping a numbered options menu with env-var and campus instructions.
  The `CREDENTIALS_REQUIRED` / `NOT_AUTHENTICATED` recovery text explicitly
  forbids the options wall so clients like Cursor prompt cleanly inline.

### Docs
- Made it explicit everywhere (README, package description, keywords) that
  only **VIT Chennai** (`vtopcc.vit.ac.in`) is tested. Other campuses are
  marked unverified rather than implied as supported.

## [0.1.4] - 2026-05-19

### Fixed
- Reverted the bin name back to `vtop-mcp` (matching the scope-stripped
  package name). `npx @vikranth2005/vtop-mcp` infers the command from the
  package basename; when the only bin had a different name
  (`vtop-mcp-server`), npx's Windows command-resolution fell into a flaky
  path and failed with "'vtop-mcp-server' is not recognized". With the bin
  named `vtop-mcp` (== basename) npx resolves it directly. The 0.1.2 rename
  was chasing the wrong cause â€” the real 0.1.0/0.1.1 bug was the bin file
  mode (fixed in 0.1.3 via Linux CI publish). 0.1.4 keeps the 0755 fix and
  restores the correct bin name.

## [0.1.3] - 2026-05-18

### Fixed
- **`npx` still failed on Windows after 0.1.2.** The real cause was not the
  bin name but the bin **file mode**: the published `dist/index.js` was
  `0644` (not executable), so npm's bin-linking produced a broken Windows
  shim. `tsup` emits the shebang but never sets `+x`. Windows `npm publish`
  cannot write the POSIX exec bit into the tarball, so the package must be
  published from the Linux GitHub Actions workflow, which now `chmod +x`'s
  the bin. The `build` script also chmods locally for non-Windows dev.

## [0.1.2] - 2026-05-18

### Fixed
- **Windows `npx` invocation failed** with `'vtop-mcp' is not recognized as
  an internal or external command`. Cause: the `bin` name (`vtop-mcp`) was
  identical to the scope-stripped package name (`@vikranth2005/vtop-mcp` â†’
  `vtop-mcp`), which trips an npm-on-Windows command-resolution bug. Renamed
  the bin to `vtop-mcp-server` (distinct from the package basename, matching
  the convention used by `@modelcontextprotocol/server-*`). `npx -y
  @vikranth2005/vtop-mcp` now works on Windows, macOS, and Linux. No change
  to the MCP server identity (`vtop-mcp`) or the `mcpServers` config key.

## [0.1.1] - 2026-05-18

### Changed
- When `VTOP_USERNAME` / `VTOP_PASSWORD` are **not** set as env vars, the
  assistant now reliably asks for them in chat instead of dead-ending. All
  tool descriptions and the `NOT_AUTHENTICATED` recovery message now spell
  out both paths (env-var auto-login vs. ask-the-user-then-login).

## [0.1.0] - 2026-05-18

### Added
- Initial release. 12 tools: `get_captcha`, `login`, `logout`,
  `get_semesters`, `get_profile`, `get_attendance`, `get_timetable`,
  `get_marks`, `get_exam_schedule`, `get_semester_grades`,
  `get_grade_history`, `get_curriculum_progress`.
- Auto-detects the active semester (probes the 3 most recent terms, skips
  Summer Term when not enrolled).
- Env-var auto-login, captcha returned as an image for the model to OCR.
- Supports VIT Chennai (default), Vellore, AP, Bhopal via `VTOP_BASE_URL`.
