# VTOP Bhopal MCP

> Ask your AI assistant about your **VIT Bhopal** VTOP account: attendance, marks, timetable, exams, grades, pass eligibility, the academic calendar, hostel leave — and "how many classes can I still skip?".

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
![Node 20.6+](https://img.shields.io/badge/node-%E2%89%A520.6-brightgreen)
![MCP](https://img.shields.io/badge/MCP-stdio-purple)

This is an [MCP](https://modelcontextprotocol.io) server for **VIT Bhopal's**
VTOP portal. Once it's connected to OpenCode, Claude Code, Claude Desktop, Cursor
or any other MCP client, you can just ask:

> *"What's my attendance?"*
> *"Which classes do I have on Monday?"*
> *"How many more classes can I skip and still hold 75%?"*
> *"When is my Security Engineering FAT, and where?"*
> *"What do I need to score in the TEE to pass?"*
> *"Is my hostel leave approved yet?"*

The assistant logs in to VTOP for you, fetches the page, and answers in plain
language. It has been built and tested against the live Bhopal portal.

---

> ### Exactly one tool writes to your VTOP account
>
> Of the 23 tools below, **22 are strictly read-only** — they sign in, fetch a
> page and report what it says. They cannot change anything.
>
> **The one exception is `apply_leave`**, which submits a real hostel leave
> application for your proctor to action. That is the only write in this server.
>
> It cannot fire by accident. It is deliberately two-step:
>
> 1. A **preview** call validates the request and returns a fingerprint token.
>    Nothing is sent to VTOP.
> 2. A **confirm** call must repeat the identical fields *and* that token. Change
>    any field in between and the submission is refused and must be previewed
>    again.
>
> It also declares `readOnlyHint: false`, so a compliant MCP client raises a
> permission prompt rather than auto-approving it. See
> [Hostel leave](#hostel-leave).

---

## Contents

- [What it can do](#what-it-can-do)
- [Quick start](#quick-start)
- [Connect it to your assistant](#connect-it-to-your-assistant)
- [How login works](#how-login-works)
- [Hostel leave](#hostel-leave)
- [Privacy and security](#privacy-and-security)
- [How VTOP behaves on Bhopal](#how-vtop-behaves-on-bhopal)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Limitations](#limitations)
- [Credits and license](#credits-and-license)

---

## What it can do

**Read tools** (18)

| Tool | What you get |
|---|---|
| `get_attendance` | Attended / total / percentage per course |
| `calculate_attendance` | Bunk calculator: how many classes you can still skip (or must attend) to stay above 75%. Give it a date and it projects real classes up to that day using your timetable and the academic calendar. |
| `get_today_classes` | Classes for today or any date, with times and rooms. Knows about holidays and Saturdays that follow another weekday's timetable. |
| `get_timetable` | Registered courses with slots, venues, faculty and credits |
| `get_marks` | CAT and other internal-assessment marks with weightage |
| `get_internal_totals` | Total marks scored per subject this semester, with a per-course breakdown and every component still to come |
| `get_exam_schedule` | CAT-1, CAT-2 and FAT dates, sessions, times, venues and seats |
| `check_pass_eligibility` | What you need to score to pass, per course, in **both** scales — and which classes or exams a leave would cost you |
| `get_semester_grades` | Grades and GPA for one semester |
| `get_grade_history` | CGPA, credits, and every course grouped by exam month |
| `get_curriculum_progress` | Credits earned vs required, by category and basket |
| `calculate_od` | On-Duty days used this semester vs the event-OD limit ([see note](#limitations)) |
| `get_calendar` | Academic calendar: holidays, exams, events, instructional days |
| `get_profile` | Name, registration number, programme and branch, school |
| `get_semesters` | All your semesters and their IDs |
| `get_leave_types` | The hostel leave types VTOP currently offers, read from the live form |
| `get_leave_status` | Your leave applications: id, type, dates, approval status, approver remarks, gate-pass flags |
| `session_status` | Whether you're logged in, as whom, and whether VTOP still honours the session |
| `get_captcha`, `login`, `logout` | Used by the assistant to sign in and out |

**Write tool** (1)

| Tool | What it does |
|---|---|
| `apply_leave` | Applies for hostel leave on VTOP. **Two-step** — see [Hostel leave](#hostel-leave) |

**Diagnostic** (1)

| Tool | What it does |
|---|---|
| `get_leave_type_rules` | Asks VTOP what rules apply to each leave type by replaying the dropdown's own request. Never submits anything. |

Every per-semester tool picks the current semester automatically, so you rarely need to name one.

---

## Quick start

You need **Node.js 20.6 or newer** (`node -v` to check) and **git**.

```bash
git clone https://github.com/CipherxHub/vtop-bhopal-mcp.git
cd vtop-bhopal-mcp
npm install
npm run build
```

### Save your VTOP login (optional, recommended)

Create a file called `.env` in the project folder:

```bash
VTOP_USERNAME=your-registration-number
VTOP_PASSWORD=your-vtop-password
```

Then make it readable only by you:

```bash
chmod 600 .env
```

`.env` is in `.gitignore`, so it never gets committed. If you skip this step, the assistant asks for your username and password in the chat the first time it needs them.

---

## Connect it to your assistant

Replace `/path/to/vtop-bhopal-mcp` with where you cloned it.

### OpenCode

OpenCode V2 keeps servers under `mcp.servers`, and `command` is an **array**.
Add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "vtop": {
        "type": "local",
        "command": ["node", "D:/vtop-bhopal-mcp/dist/index.js"],
        "cwd": "D:/vtop-bhopal-mcp",
        "environment": { "VTOP_TIMEOUT_MS": "60000" }
      }
    }
  }
}
```

Check it, then restart the background service if it still looks stale:

```sh
opencode mcp list      # ✓ vtop  connected
opencode service restart   # only if the tool list looks out of date
```

Tools appear as `vtop_*`, e.g. `vtop_get_attendance`, `vtop_session_status`.

Two things to know:

- **Credentials stay out of the config.** Without a `.env` the server asks you
  for your username and password in the chat the first time it needs them.
- **Don't put `--env-file` in `command` unless `.env` exists.** Node exits with
  `not found` rather than ignoring a missing env file, which makes the server
  fail to start (it shows as `✗ vtop failed`). Create `.env` first, then add the
  flag: `"command": ["node", "--env-file=D:/vtop-bhopal-mcp/.env", "D:/vtop-bhopal-mcp/dist/index.js"]`.

Under Code Mode (the default) a tool that fails with `isError` is surfaced to
the model as its text only — the `structuredContent` is still sent on the wire
and clients that read it directly get the full error body.

### Claude Code

```bash
claude mcp add vtop-bhopal -s user -- node --env-file=/path/to/vtop-bhopal-mcp/.env /path/to/vtop-bhopal-mcp/dist/index.js
```

Check it's connected:

```bash
claude mcp list
# vtop-bhopal: ... - ✔ Connected
```

Start a **new** session and ask *"what's my attendance?"*.

### Claude Desktop

Open **Settings → Developer → Edit Config** and add:

```json
{
  "mcpServers": {
    "vtop-bhopal": {
      "command": "node",
      "args": [
        "--env-file=/path/to/vtop-bhopal-mcp/.env",
        "/path/to/vtop-bhopal-mcp/dist/index.js"
      ]
    }
  }
}
```

Fully quit and reopen Claude Desktop.

### Cursor, Windsurf, Cline, Zed and others

Use the same `command` and `args` as the Claude Desktop example in your client's MCP config file.

> **Didn't create a `.env`?** Drop the `--env-file=…` argument. The assistant will ask for your login in the chat instead.

---

## How login works

1. The assistant calls `get_captcha`. VTOP shows a small text captcha, which the assistant reads from the image.
2. It calls `login` with that captcha (plus your saved username and password).
3. It fetches what you asked for.

Things to know:

- **Sessions idle out after ~20 minutes.** VTOP signs a session out after roughly 20 minutes of *inactivity* — it is an idle timeout, not a fixed lifetime from login. The server therefore touches the session every 5 minutes by default (`VTOP_KEEPALIVE_MINUTES`), so an open session stays usable indefinitely. If a session does lapse (a long network outage, a server restart), the assistant logs in again and you may see it read a new captcha.
- **Sometimes VTOP shows a Google reCAPTCHA** instead of the text captcha. The server reloads the login page a few times until the text captcha appears, so this is usually invisible to you. If it persists, wait a few minutes — repeated attempts escalate VTOP's risk scoring.
- **Captchas expire in well under a minute.** The assistant fetches one and submits it immediately. If a read is ever missed, ask it for a fresh captcha and type the characters yourself — that's faster and more reliable than a re-read. The image is upscaled 5× server-side so it stays legible in clients that would otherwise render a 200×40 image as a smear.

---

## Hostel leave

`apply_leave` is the one tool that **writes to VTOP**. It creates a real
application that your hostel proctor has to action, so it is deliberately
two-step.

**Call 1 — preview.** Pass the details and leave `confirm` unset. Nothing is
sent. You get back the normalised values, every rule that fired, a
`previewToken`, and what the leave would cost you:

- **classes** it would make you miss, from your timetable and the academic calendar
- **exams** it would clash with, compared against the *hours* you are away —
  a leave starting at 17:00 does not cost you a 13:15–16:15 paper, one starting
  at 08:00 does. An exam with no published time is reported as `UNKNOWN`,
  never assumed clear.

**Call 2 — submit.** Repeat the *identical* fields plus `confirm: true` and the
`previewToken`. The token is a fingerprint over every submitted field, so if
anything changed since the preview the submission is **refused** and you must
preview again. That is what stops "confirm" from drifting onto a request you
never actually saw.

**Tell the assistant to show you the preview before confirming.**

```jsonc
// "apply for a day outing on the 20th, Sehore, 9am to 6pm, family function"
{ "leaveCode": "OG1", "visitingPlace": "Sehore",
  "leaveFromDate": "2026-10-20", "fromTime": "9:00 AM",
  "leaveToDate": "2026-10-20", "toTime": "6:00 PM",
  "reason": "Family function in Sehore." }
```

Leave types are read from VTOP's live dropdown, not hard-coded:

| Code | Type | Code | Type |
|---|---|---|---|
| `SO` | Special Outing | `WV` | Winter Vacation |
| `WP` | With Parent Leave | `HT1` | Home Town |
| `EP` | Official Leaves | `LG1` | Local Guardian |
| `SV` | Summer Vacation | `EY1` | Emergency Leave |
| | | `OG1` | **Day Outing** |

Rules enforced before anything is sent:

- **A Day Outing (`OG1`) must return by 18:00**, inclusive — 18:00 passes,
  18:01 is refused. The deadline applies to that type only; other types are
  allowed later but produce a warning, because a proctor may still query it.
- Times are normalised first, so `6:00 PM`, `1800` and `8.30` all work, and the
  preview and the submission always see identical values.
- Dates must be ISO `YYYY-MM-DD` and not in the past; the return cannot precede
  the departure; visiting place is required and capped at VTOP's 150 characters;
  reason is required.

**On duration limits:** VTOP enforces a maximum length per leave type
server-side and publishes none of them — not in the form markup, not in the
dropdown's response. The only cap confirmed is **Home Town ≤ 14 days**. The tool
refuses that one case locally and deliberately does *not* guess the others:
inventing a limit would block applications VTOP would have accepted. If VTOP
rejects a request, nothing is created and you can apply under another type.

---

## Privacy and security

- **Your login only goes to VTOP.** The server runs on your own computer and talks directly to `vtop.vitbhopal.ac.in`. It never sends your username or password anywhere else.
- **Nothing is stored except what you choose.** Session cookies live in memory and vanish when the server stops. Your password is stored only in your own `.env` file, if you create one.
- **Your assistant sees your data.** Whatever the tools return (marks, attendance and so on) goes to the AI assistant you connected, the same as anything else you ask it about.
- **`apply_leave` writes to your VTOP account.** Everything else only reads. See [Hostel leave](#hostel-leave).
- **Test scripts save raw VTOP pages** to `test-output/` when `VTOP_DUMP_HTML=1`. Those pages contain your personal data, which is why that folder is git-ignored. Don't share it.
- **`.env` is plain text.** Keep it `chmod 600` and don't commit it.

---

## How VTOP behaves on Bhopal

VTOP's markup is idiosyncratic, and several of these cost real debugging time.
If you extend this server, they are the things that will bite you:

| Area | What Bhopal actually does |
|---|---|
| Portal | `vtop.vitbhopal.ac.in` (default; override with `VTOP_BASE_URL`) |
| Semester list | `StudentTimeTable`. The Chennai-era path returns "not available" |
| Attendance | combined "Course Detail" / "Class Detail" cells, and the header row has **no `<th>`** — a positional parser hangs on it, so rows are matched by content |
| Per-class attendance (OD) | `callStudentAttendanceDetailDisplay(semester, regNo, courseId, type)`, and a summary table precedes the per-class one |
| Exam schedule | an extra "General (Semester)" row sits **above** the header row |
| Semester grades | Credits split into L / P / J / C, plus Grading Type and Grand Total |
| Grade history | grouped by exam month, but course codes like `ENG1004` look exactly like month names — the parser has to tell them apart. `P` (pass) grades are excluded from GPA |
| Profile branch | the profile page only carries the Class 12 stream, so the branch is read from the grade-history header |
| Calendar | every student group is listed per day; only the "General" entry is used. Saturdays marked "Activities Friday" follow Friday's timetable, and working Saturdays can override the weekday |
| Timetable | the grid returns empty day/time cells; each course cell carries a nested `sessions` array, which is merged in so day and times are populated |
| Leave | `hostels/student/leave/1..4` — one path family driven by a `control` parameter, not separate routes. The form and status views are unreachable until the page shell is loaded first, and VTOP publishes **no duration limits** anywhere |
| Attendance marks | binary at 75%+ in this semester, banded (95+/90+/<75%) in earlier ones — the rule is inferred per semester from published data, and reported as `unknown` when it can't be |
| Failure pages | "menu not available" and "unable to process" both arrive as **HTTP 200** and would otherwise parse as empty results |

All of this is covered by offline fixtures in `scripts/fixtures.ts` and
`scripts/*-test.ts`. **Those fixtures use synthetic data only** — see
[CONTRIBUTING.md](CONTRIBUTING.md) for the rule and the guard that enforces it.

---

## Troubleshooting

**The assistant doesn't see the VTOP tools.** Start a new session after adding the server; tools load at startup. In Claude Code, `claude mcp list` should show `✔ Connected`. In OpenCode, `opencode service restart` re-reads the config.

**`node: bad option: --env-file`.** Your Node is older than 20.6. Update Node, or drop the `--env-file` argument and log in through the chat.

**A tool returns `error.code: RECAPTCHA_REQUIRED`.** VTOP served Google reCAPTCHA instead of the readable image captcha, usually because your IP looks like a datacenter or you have attempted several logins recently. Wait a few minutes and retry, or set `VTOP_PROXY_URL` to a residential proxy.

**A tool returns `error.code: ENDPOINT_NOT_FOUND`.** VTOP has no endpoint at that path. **Do not log in again** — the session is fine; the route is wrong or has been renamed. Please [open an issue](https://github.com/CipherxHub/vtop-bhopal-mcp/issues).

**Login keeps failing with `SESSION_MISMATCH` (HTTP 404).** The captcha belonged to a different VTOP session than the login POST. Fetch a fresh captcha and retry — don't reuse the old one.

**"Invalid username or password".** Check `.env` for typos and stray spaces around `=`. Try logging in on the VTOP website to be sure.

**Login keeps failing on the captcha.** It expires fast. Ask the assistant for a fresh captcha and type the characters yourself.

**`timeout of 30000ms exceeded`.** VTOP is slow (common late at night or on result days). Add `VTOP_TIMEOUT_MS=60000` to your `.env`.

**A tool returns empty data while you can see it on the website.** VTOP's pages change from time to time. Please [open an issue](https://github.com/CipherxHub/vtop-bhopal-mcp/issues) with the tool name and what you expected. **Don't paste raw pages or screenshots that show personal details.**

---

## Development

```bash
npm install
npm run build          # compile to dist/
npm run typecheck      # tsc --noEmit (the build itself does NOT typecheck)
npm run test:parser    # offline parser checks (Bhopal fixtures)
npm run test:tools     # offline tool checks with a fake VTOP client
npm run test:login     # offline login-handshake checks against a mock VTOP
npm run test:exam      # pass-rule arithmetic
npm run test:leave     # leave validation, fingerprints, exam overlap
npm run test:privacy   # fixture hygiene guard
npm run test:all       # everything above, then build + MCP protocol smoke test
```

Every suite except the `e2e` ones is **offline and needs no VTOP account**, which
is deliberate so the suite is safe to run in CI.

`npm run test:login` starts a local mock of the VTOP portal (TLS, throwaway
self-signed cert generated into the temp dir — nothing is written to the repo)
and drives the real `VtopClient` through the whole handshake: the prelogin
handshake, captcha retrieval, a successful login, every login failure mode,
mid-session expiry, and the mapping from each failure to its error code. It
needs `openssl` on PATH; it never touches the network.

### Errors are structured, not prose

Failures carry a machine-readable `structuredContent.error`, so a client can
branch on a stable `code` instead of parsing English:

```json
{
  "ok": false,
  "error": {
    "code": "NOT_AUTHENTICATED",
    "message": "VTOP session expired.",
    "retryable": false,
    "needsUserInput": false,
    "recovery": ["get_captcha", "login"]
  }
}
```

Codes: `NOT_AUTHENTICATED`, `CREDENTIALS_REQUIRED`, `INVALID_CAPTCHA`,
`INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`, `MAX_LOGIN_ATTEMPTS`,
`SESSION_MISMATCH`, `RECAPTCHA_REQUIRED`, `CAPTCHA_NOT_FOUND`, `TIMEOUT`,
`NETWORK`, `ENDPOINT_NOT_FOUND`, `UPSTREAM`.

`ENDPOINT_NOT_FOUND` is deliberately distinct from `NOT_AUTHENTICATED`. VTOP
serves 404 for some endpoints when a session is dead, but it also serves 404 for
a path that simply does not exist. Treating the latter as a dead session used to
log you out of a perfectly good one and send you round the captcha loop for
nothing; now the session is verified against a known-good endpoint before it is
condemned.

`recovery` is the ordered list of tools to call; `needsUserInput` tells you
whether a human has to supply something first. The human-readable text and the
structured payload are generated from the same source, so they can't disagree.

### session_status

Call `session_status` to check login state without burning a captcha
round-trip. It reports whether a session is active, the registration number,
and whether credentials are configured — and it verifies the session against
VTOP, so a session that died server-side is caught there rather than on your
next question.

### Write tools and MCP permissions

Tools that write to VTOP declare `readOnlyHint: false` so a compliant MCP client
raises a permission prompt instead of auto-approving. The smoke test asserts
this, so a new write path cannot silently inherit the read-only default and
skip the prompt entirely.

### No grade or GPA predictor, on purpose

There is deliberately **no tool that predicts a letter grade**, and no
`calculate_gpa`. VIT awards letter grades *relatively* — against the class
average and its spread — and VTOP exposes neither, so any prediction would be
the user supplying a guess and getting a guess back. `get_grade_history` and
`get_semester_grades` report the grades VTOP actually awarded,
`get_internal_totals` reports your real marks, and `check_pass_eligibility`
reports the thresholds the published rules impose. Nothing extrapolates.

### Fixture data — synthetic only

Tests may mirror the real **shape** of a VTOP response (field names, dropdown
order, column order, printed date formats) because that cannot be guessed. They
must never carry real **values**. `npm run test:privacy` fails the build if
identifiable data appears, and matches patterns rather than a blocklist so it
catches fresh leaks. See [CONTRIBUTING.md](CONTRIBUTING.md).

### Internal marks totals — read the percentages carefully

`get_internal_totals` sums each course's `weightage` column, which VTOP has
already scaled to the internal total (a CAT scored 44/50 with a weightage of 15
shows `13.2`). **Marks scored are exact.**

The percentages are not, and the tool says so on every call:

- **VTOP omits components that have not happened yet** rather than showing them
  as zero. A mid-semester course may list only its two CATs (30 marks) with no
  FAT row at all.
- **There is no total row, and the internal scale is not a constant 50.** A
  course with labs and tutorial assessments listed seven components totalling
  65.

So a course that reports a high percentage against a small published total may
look far stronger against its real total than it is. Treat `scoredSoFar` as the
number to trust and any percentage as a lower bound. The returned `note` repeats
this to the assistant on every call.

---

## Limitations

- **Unofficial.** Not affiliated with or endorsed by VIT Bhopal. It reads the same pages your browser does; if VTOP changes them, parts may break until updated.
- **It can write — one tool can.** `apply_leave` submits a real leave application. Every other tool only reads: it never registers courses, changes marks, or opens fee and payment pages. The write is two-step and cannot fire without an explicit confirm call; see [Hostel leave](#hostel-leave).
- **Leave duration limits are partly unknown.** VTOP enforces them server-side and publishes none. Only Home Town ≤ 14 days is confirmed, and that one is checked locally. Guessing the rest would block valid requests, so it isn't attempted.
- **Exam overlap is a warning, not a block.** If a leave conflicts with an exam, `apply_leave` says so prominently but still allows submission — sometimes a clash is unavoidable, and that isn't the tool's decision to make.
- **OD limit is unconfirmed.** `calculate_od` counts distinct OD days against **8**, based on students' understanding that about 8–9 event ODs are allowed and DSW-approved ODs are unlimited. VTOP doesn't mark which ODs were DSW-approved, so all OD days are counted. Check the official rule with your school or the DSW office, and if you have a source, please open an issue.
- **Bunk calculator uses 75%,** treating 74.x% as safe. Check your own course rules.
- **Tested on a B.Tech account (Fall Semester 2026-27).** Other programmes may see different layouts.
- **The multi-user HTTP connector is included but untested on Bhopal.** Review it before exposing it.

---

## Credits and license

This is a standalone project maintained for VIT Bhopal students. It stands on its
own: its own issue tracker, its own release history, its own roadmap.

It did not appear from nothing, and the licence terms of the earlier work it
grew from continue to apply to the code that came from there. That attribution
is a legal obligation of the MIT licence those projects were released under, not
a claim that this project is a fork of them:

- [VtopMCP](https://github.com/Vikranth-jagdish/VtopMCP) by Vikranth Jagdish (MIT)
- [divyarthjain/vtop-bhopal-mcp](https://github.com/divyarthjain/vtop-bhopal-mcp), which adapted it toward Bhopal
- which itself followed how the [android-vtop-chennai](https://github.com/therealsujitk/android-vtop-chennai) app talks to VTOP

This project is released under the [Apache License 2.0](LICENSE). Portions
derived from the projects above remain under their MIT terms — see [NOTICE](NOTICE)
for the full attribution chain and [LICENSE-MIT-upstream](LICENSE-MIT-upstream)
for the licence text those portions carry.