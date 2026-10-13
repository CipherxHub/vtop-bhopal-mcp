# VTOP Bhopal MCP

> Ask your AI assistant about your **VIT Bhopal** VTOP account: attendance, marks, timetable, exams, grades, the academic calendar, and "how many classes can I still skip?".

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
![Node 20.6+](https://img.shields.io/badge/node-%E2%89%A520.6-brightgreen)
![MCP](https://img.shields.io/badge/MCP-stdio-purple)

This is an [MCP](https://modelcontextprotocol.io) server. Once it's connected to Claude Code, Claude Desktop, Cursor or any other MCP client, you can just ask:

> *"What's my attendance?"*
> *"Which classes do I have on Monday?"*
> *"Can I skip any more Analog classes before the last instructional day?"*
> *"When is my Chemistry FAT, and where?"*
> *"What GPA do I need next semester to reach an 8 CGPA?"*

The assistant logs in to VTOP for you (it reads the captcha itself), fetches the page, and answers in plain language.

It's a fork of [VtopMCP](https://github.com/Vikranth-jagdish/VtopMCP), which was built for VIT Chennai. VIT Bhopal's VTOP looks similar but differs in many places, so this fork reworks the endpoints and parsers for Bhopal and has been tested against the live Bhopal portal.

---

## Contents

- [What it can do](#what-it-can-do)
- [Quick start](#quick-start)
- [Connect it to your assistant](#connect-it-to-your-assistant)
- [How login works](#how-login-works)
- [Privacy and security](#privacy-and-security)
- [What's different from the Chennai version](#whats-different-from-the-chennai-version)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Limitations](#limitations)
- [Credits and license](#credits-and-license)

---

## What it can do

| Tool | What you get |
|---|---|
| `get_attendance` | Attended / total / percentage per course |
| `calculate_attendance` | Bunk calculator: how many classes you can still skip (or must attend) to stay above 75%. Give it a date and it projects real classes up to that day using your timetable and the academic calendar. |
| `get_today_classes` | Classes for today or any date, with times and rooms. Knows about holidays and Saturdays that follow another weekday's timetable. |
| `get_timetable` | Registered courses with slots, venues, faculty and credits |
| `get_marks` | CAT and other internal-assessment marks with weightage |
| `get_internal_totals` | Total marks scored per subject this semester, with a per-course breakdown |
| `get_exam_schedule` | CAT-1, CAT-2 and FAT dates, sessions, times, venues and seats |
| `get_semester_grades` | Grades and GPA for one semester |
| `get_grade_history` | CGPA, credits, and every course grouped by exam month |
| `get_curriculum_progress` | Credits earned vs required, by category and basket |
| `calculate_od` | On-Duty days used this semester vs the event-OD limit ([see note](#limitations)) |
| `get_calendar` | Academic calendar: holidays, exams, events, instructional days |
| `get_profile` | Name, registration number, programme and branch, school |
| `session_status` | Whether you're logged in, as whom, and whether VTOP still honours the session |
| `get_semesters` | All your semesters and their IDs |
| `get_captcha`, `login`, `logout` | Used by the assistant to sign in and out |

Every per-semester tool picks the current semester automatically, so you rarely need to name one.

---

## Quick start

You need **Node.js 20.6 or newer** (`node -v` to check) and **git**.

```bash
git clone https://github.com/divyarthjain/vtop-bhopal-mcp.git
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
- **Sometimes VTOP shows a Google reCAPTCHA** instead of the text captcha. The server reloads the login page a few times until the text captcha appears, so this is usually invisible to you.
- **A misread captcha isn't a problem.** The assistant fetches a new one and tries again.

- **Captchas expire quickly.** VTOP's captchas are short-lived, so read the image
  and submit `login` straight away — a long pause between the two reads means
  `INVALID_CAPTCHA`. The returned image is upscaled 5x server-side so it stays
  legible in clients that would otherwise render a 200x40 image as an
  unreadable smear.

---

## Privacy and security

- **Your login only goes to VTOP.** The server runs on your own computer and talks directly to `vtop.vitbhopal.ac.in`. It never sends your username or password anywhere else.
- **Nothing is stored except what you choose.** Session cookies live in memory and vanish when the server stops. Your password is stored only in your own `.env` file, if you create one.
- **Your assistant sees your data.** Whatever the tools return (marks, attendance and so on) goes to the AI assistant you connected, the same as anything else you ask it about.
- **The test scripts save raw VTOP pages** to `test-output/`. Those pages contain your personal data, which is why that folder is git-ignored. Don't share it.
- **`.env` is plain text.** Keep it `chmod 600` and don't commit it.

---

## What's different from the Chennai version

VIT Bhopal's VTOP runs on the same platform as Chennai's but differs in the details. This fork changes:

| Area | Chennai (upstream) | Bhopal (this fork) |
|---|---|---|
| Portal | `vtopcc.vit.ac.in` | `vtop.vitbhopal.ac.in` (default) |
| Semester list | `StudentTimeTableChn` | `StudentTimeTable` (the Chennai page is disabled on Bhopal) |
| Attendance | separate code / title / slot columns | combined "Course Detail" and "Class Detail" cells; header row has no `<th>` (this used to hang the parser) |
| Per-class attendance (OD) | `processViewAttendanceDetail(classId, slot)` | `callStudentAttendanceDetailDisplay(semester, regNo, courseId, type)`, plus a summary table before the per-class table |
| Exam schedule | header row first | an extra "General (Semester)" row above the header |
| Semester grades | single Credits column | Credits split into L / P / J / C, plus Grading Type and Grand Total |
| Grade history | grouped by exam month | same, but course codes like `ENG1004` were being mistaken for months; `P` (pass) grades are now kept out of GPA |
| Profile branch | "Branch" field | taken from the grade-history header (the profile page only has the Class 12 stream) |
| Calendar | one entry per day | every student group listed per day; only the "General" entry is used. Saturdays marked "Activities Friday" follow Friday's timetable. |
| OD limit | 40 hours per semester | event-OD days ([see note](#limitations)) |

The Bhopal-specific layouts are covered by offline test fixtures (synthetic data only) in `scripts/fixtures.ts`.

---

## Troubleshooting

**The assistant doesn't see the VTOP tools.** Start a new session after adding the server; tools load at startup. In Claude Code, `claude mcp list` should show `✔ Connected`.

**`node: bad option: --env-file`.** Your Node is older than 20.6. Update Node, or drop the `--env-file` argument and log in through the chat.

**A tool returns `error.code: RECAPTCHA_REQUIRED`.** VTOP served Google reCAPTCHA instead of the readable image captcha, usually because your IP looks like a datacenter. Wait a few minutes and retry, or set `VTOP_PROXY_URL` to a residential proxy.

**Login keeps failing with `SESSION_MISMATCH` (HTTP 404).** The captcha belonged to a different VTOP session than the login POST. Fetch a fresh captcha and retry — don't reuse the old one.

**"Invalid username or password".** Check `.env` for typos and stray spaces around `=`. Try logging in on the VTOP website to be sure.

**Login keeps failing on the captcha.** It's usually a misread; the assistant retries. If VTOP keeps serving the Google reCAPTCHA, wait a few minutes and try again.

**`timeout of 30000ms exceeded`.** VTOP is slow (common late at night or on result days). Add `VTOP_TIMEOUT_MS=60000` to your `.env`.

**A tool returns empty data while you can see it on the website.** VTOP's pages change from time to time. Please [open an issue](https://github.com/divyarthjain/vtop-bhopal-mcp/issues) with the tool name and what you expected. **Don't paste raw pages or screenshots that show personal details.**

---

## Development

```bash
npm install
npm run build          # compile to dist/
npm run typecheck      # tsc --noEmit (the build itself does NOT typecheck)
npm run test:parser    # offline parser checks (Chennai + Bhopal fixtures)
npm run test:tools     # offline tool checks with a fake VTOP client
npm run test:login     # offline login-handshake checks against a mock VTOP
npm run test:all       # everything above, then build + MCP protocol smoke test
```

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
`NETWORK`, `UPSTREAM`.

`recovery` is the ordered list of tools to call; `needsUserInput` tells you
whether a human has to supply something first. The human-readable text and the
structured payload are generated from the same source, so they can't disagree.

### session_status

Call `session_status` to check login state without burning a captcha
round-trip. It reports whether a session is active, the registration number,
and whether credentials are configured — and it verifies the session against
VTOP, so a session that died server-side is caught there rather than on your
next question.

Live checks against the real portal (needs your login in `.env`; you type the captcha):

```bash
npm run test:e2e                        # core tools, parser level
VTOP_MCP_TOOLS=1 npm run test:e2e       # every tool through the real MCP server
VTOP_MENU_DUMP=1 npm run test:e2e       # list VTOP's menu pages and save them
VTOP_DUMP_HTML=1 npm run test:e2e       # also save raw HTML to test-output/
```

Useful environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `VTOP_USERNAME` / `VTOP_PASSWORD` | none | Auto-login. Without them the assistant asks in chat. |
| `VTOP_BASE_URL` | `https://vtop.vitbhopal.ac.in/vtop` | Portal address |
| `VTOP_TIMEOUT_MS` | `30000` | Per-request timeout |
| `VTOP_KEEPALIVE_MINUTES` | `5` | How often to touch VTOP so an idle session survives its ~20 min timeout. `0` disables all background traffic. |
| `VTOP_CAPTCHA_SCALE` | `5` | Upscale factor for the returned captcha (200x40 → 1000x200). `1` returns it untouched. |
| `VTOP_DUMP_CAPTCHA` | unset | `1` also writes each raw captcha to `VTOP_DUMP_DIR` (default `test-output/`). Debug aid. |

The upstream HTTP / ChatGPT-connector mode (`dist/http.js`) is still included but hasn't been tested on Bhopal.

---

### No grade or GPA predictor, on purpose

There is deliberately **no tool that predicts a letter grade**, and no
`calculate_gpa`. VIT awards letter grades *relatively* — against the class
average and its spread — and VTOP exposes neither, so any prediction would be
the user supplying a guess and getting a guess back. `get_grade_history` and
`get_semester_grades` report the grades VTOP actually awarded, and
`get_internal_totals` reports your real marks. Nothing extrapolates.

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

So a course at 28.8 of a published 30 reports 96%, when against its real 50 it
is 57.6%. Treat `scoredSoFar` as the number to trust and any percentage as a
lower bound. The returned `note` repeats this to the assistant on every call.

## Limitations

- **Unofficial.** Not affiliated with or endorsed by VIT Bhopal. It reads the same pages your browser does; if VTOP changes them, parts may break until updated.
- **Read-only.** It only signs in and reads pages. It never registers courses or changes anything on VTOP, and fee and payment pages are never opened.
- **OD limit is unconfirmed.** `calculate_od` counts distinct OD days against **8**, based on students' understanding that about 8–9 event ODs are allowed and DSW-approved ODs are unlimited. VTOP doesn't mark which ODs were DSW-approved, so all OD days are counted. Check the official rule with your school or the DSW office, and if you have a source, please open an issue.
- **Bunk calculator uses 75%,** treating 74.x% as safe, as upstream does. Check your own course rules.
- **Tested on a B.Tech account (Fall Semester 2026-27).** Other programmes may see different layouts.

---

## Credits and license

- Original project: [VtopMCP](https://github.com/Vikranth-jagdish/VtopMCP) by Vikranth Jagdish (MIT License), itself based on how the [android-vtop-chennai](https://github.com/therealsujitk/android-vtop-chennai) app talks to VTOP.
- This fork is released under the [Apache License 2.0](LICENSE). Code from the original project remains under its MIT terms; see [NOTICE](NOTICE) and [LICENSE-MIT-upstream](LICENSE-MIT-upstream).
