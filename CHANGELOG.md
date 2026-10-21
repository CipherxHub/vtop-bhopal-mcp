# Changelog

Notable changes to **vtop-bhopal-mcp** are documented here. This project
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Script-call withdraw.** cancel_leave now executes requestDataListUpdate
  Cancel buttons (POST hostels/student/leave/5, TABLE branch replayed byte
  for byte) instead of refusing them as non-links. Anything else unrecognised
  still refuses loud.
- **Profile photo.** get_profile also returns the avatar as a saved file
  (`photoFile`, magic-sniffed since VTOP serves JPEG bytes as image/png). A
  missing image degrades to null plus a note — the text fields never fail for
  it.
- **Faculty directory search.** search_faculty queries Academics → Faculty
  Info by name fragment (minimum 3 letters, letters/spaces only, mirroring
  the page) and returns every match with its detail card (department, email,
  cabin — null when unpublished) in one call. The search posts the fragment
  as `empId`; each row's employee id (numeric or alphanumeric) keys the
  detail call.
- **Syllabus download.** get_course_syllabus fetches
  `courseSyllabusDownload1/{CODE}` and saves the PDF under VTOP_DOWNLOAD_DIR
  (default OS temp dir), returning the file path and size. A non-PDF answer
  fails loud instead of saving a fake `.pdf`.
- **Cancel leave.** cancel_leave withdraws an applied leave behind the same
  two-step preview/confirm handshake as apply_leave (caller-bound single-use
  token). The withdraw target is read from the status view at confirm time,
  never hardcoded; script-call or missing controls refuse loud, and the
  response must re-parse as cancelled.
- **Per-class attendance detail.** get_attendance_detail answers "was I
  present on DATE in COURSE?" (PRESENT/ABSENT/ON DUTY, or NOT POSTED — never
  absent by default) and lists every posted session per course.
- **Basket lookup + grouped pending.** get_course_basket finds any catalogue
  course by code or title fragment with its basket and credits, even untaken;
  get_pending_subjects groups leftovers byBasket with per-basket counts.
- **Semester bounds.** get_semester_info reports term bounds, days remaining
  and a teaching-over flag (figures final/locked); calculate_attendance takes
  toTermEnd to project to the last instructional day automatically.
- **Degree completion maths.** get_cgpa_target says what the courses you have
  left must score to reach a target CGPA (maximum reachable, average needed,
  and a concrete mix); get_cgpa_impact says what a given set of grades does
  to the number you have now; get_failed_courses_impact shows what each
  failure costs and which grade would actually help. All three are
  requirements, not predictions.
- **Captcha conditioning.** The captcha image is de-gridded, greyscaled,
  contrast-stretched and binarised before it is delivered, so a model reads it
  correctly instead of burning login attempts on noise.
  get_acknowledgments (admission document checklist with what is still owed),
  get_proctor_details (contact record, same data as the profile section).
- **Curriculum baskets + pending subjects.** get_curriculum_baskets reports
  every category with per-course credits and VTOP's own completion marking;
  get_pending_subjects subtracts grade-history passes by course code only
  (period labels are never compared) and surfaces marking disagreements in
  `discrepancies` instead of resolving them.
- **Fee receipts.** get_fee_receipts lists every payment with a total; pass
  receiptNo back for that receipt's detail breakdown.
- **Leave history.** get_leave_history carries the full record list including
  approved past leaves, where get_leave_status keeps the current state.
- **Calendar class groups.** get_calendar takes an optional classGroup
  (COMB default, ALL/FS/FT and programme variants).
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
- **HTTP connector tests.** 20 offline checks covering routing, auth, CORS, the
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

- **Captcha file fallback.** `get_captcha` now also writes the JPEG to disk
  and returns the absolute path as `captchaFile` (default
  `%TEMP%\vtop-mcp-captcha\`, override with `VTOP_CAPTCHA_DIR`). The MCP `image`
  content block is still returned first, so clients that render it are unaffected.
- **Three-misread escalation in `login`.** After three consecutive rejected
  captchas the server returns an explicit "stop and ask the user" error naming the
  account-lock risk, instead of the generic retry hint.
- **`canPass` on `check_pass_eligibility` subjects.** The three-valued verdict
  (true / false / null) is now in the payload. It was computed and then folded
  into `status`, while the tool's own note told the model to read a field that
  was not there.
- **`get_marks` names its semester on an empty result**, and says whether that
  semester was defaulted, so "no marks" is distinguishable from a fetch failure.
- **`get_semesters` documents its ordering.** VTOP returns newest-first: index 0
  is the in-progress term and the LAST element is the oldest. Nothing said so, and
  taking the last element silently returns the student's first semester.

- **Login was impossible in clients that do not render MCP `image` content blocks**
  (confirmed on Codex's TUI and OpenCode's plain TUI). The captcha was returned
  ONLY as an image block, so those clients could not obtain it at all. The model
  was asked to read an image it could not see, guessed a plausible-looking string,
  and each guess was a real failed login against a student's account - three in a
  row observed in the wild. `get_captcha` now also hands over a file, and the
  response says explicitly never to guess.
- **README: the OpenCode MCP example did not work.** It set `cwd`, which made the
  server connect from some directories and time out from others (`Received a
  response for an unknown message ID`), and it omitted `--env-file`, so credentials
  silently never loaded.
- **Removed `calculate_od`.** It was the only tool returning a number VTOP never
  gave: `eventOdLimit: 8` came from a constant documented as an unconfirmed student
  report. The honesty lived in a `note` string while the fields themselves read as
  fact. VTOP does not mark which absences were OD-approved, so the tool could not
  separate them anyway. Every remaining tool reports only what VTOP returns.
- **Dependency audit: 16 advisories down to 1.** Includes a critical `proxy-addr`
  IP-spoofing bug inside the `trust proxy` path the HTTP connector relies on, a
  high-severity MCP SDK advisory, and ~20 axios advisories on the package that
  makes every VTOP request. The one remaining (`esbuild`, low) is a transitive
  dev-dependency of `tsup` and affects only the dev server, which this project does
  not run.
- **281 offline checks across 12 suites** (was 280).

- **EXPERIMENTAL: `VTOP_CAPTCHA_OPEN=1` opens the captcha for you.** Opt-in. On
  clients that render no MCP `image` blocks AND whose model will not open a local
  file to look at one - Codex - the round trip otherwise needs you to find the
  file yourself. With this set, the server launches a viewer (Photos / Preview /
  `xdg-open`) as soon as the JPEG is written, and the tool response tells the
  model the image is already on screen so it asks you to read it rather than
  repeating the path. Off by default: it spawns a GUI process on the host, which
  is wrong for a shared HTTP connector where every call would throw a window on
  whoever is at the keyboard. Requires a desktop session, so it is a no-op over
  SSH or in a container, and it degrades to the file path rather than failing
  login.

- **Logout no longer breaks the next login.** After a real logout, VTOP answers
  a `GET /login` that still carries the dead `JSESSIONID` with HTTP 404 instead of
  minting a fresh session — verified live twice. The client kept its cookie jar,
  so every later login failed with `UPSTREAM 404` until the process restarted.
  `logout()` now drops the jar, and the prelogin handshake starts cookieless too,
  which also covers persisted sessions VTOP has since expired. The mock reproduces
  VTOP's dead-session 404s, with regression tests that fail without the fix.
- **294 offline checks across 12 suites** (was 292).

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
