# VTOP Bhopal MCP

> Ask your AI assistant anything about your **VIT Bhopal** VTOP account — attendance, marks, timetable, exams, grades, pass eligibility, hostel leave — in plain language.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
![Node 20.6+](https://img.shields.io/badge/node-%E2%89%A520.6-brightgreen)
![MCP](https://img.shields.io/badge/MCP-stdio-purple)
[![vtop-bhopal-mcp MCP server – quality and maintenance score on Glama](https://glama.ai/mcp/servers/CipherxHub/vtop-bhopal-mcp/badges/score.svg)](https://glama.ai/mcp/servers/CipherxHub/vtop-bhopal-mcp)

An [MCP](https://modelcontextprotocol.io) server. Connect it to OpenCode, Claude Code, Claude Desktop, Cursor or anything else that speaks MCP, then just ask. It signs in to VTOP, reads the page, and answers.

> ### ⚠️ Exactly two tools write to your account
>
> Of the 35 tools, **33 are strictly read-only.** Two are not: **`apply_leave`** submits a real hostel leave application for your proctor, and **`cancel_leave`** withdraws one. Those are the only writes.
>
> Neither can fire by accident. Both are two-step — a **preview** call validates and returns a single-use token without sending anything, and a **confirm** call must repeat the identical target *and* that token. Change anything in between and it's refused. Both declare `readOnlyHint: false` so a compliant client prompts rather than auto-approving.
>
> Details in [docs/hostel-leave.md](docs/hostel-leave.md).

---

## What it looks like

**"How many more classes can I skip and still hold 75%?"**

> You can skip **4 more** classes in CSD3002 and still finish at 75.4%.
> At 5 you'd drop to 74.1%. Last chance is **28 Oct**.
>
> | Course | Attended | Can skip | Lowest safe % |
> |---|---|---|---|
> | CSD3002 Secure Software | 34/46 | 4 | 75.4% |
> | MAT2001 Differential Equations | 21/22 | 1 | 77.8% |

**"When is my Database FAT, where, and which seat?"**

> **CSD5003 Database Management Systems** — FAT
> Sat **24 Oct 2026**, Morning session, **09:30–11:00**
> Venue: AB1-305 · Seat **B14** · Hall ticket required

**"Apply for a day outing on the 20th, Sehore, 9am to 6pm, family function"**

> **Preview only — nothing has been sent.** Confirm to apply.
>
> ✓ Day Outing (`OG1`), returns 18:00 — exactly on the deadline, allowed
> ✓ 5 classes missed (Sat 24 Oct is the FAT, unaffected)
> ✓ Visiting place "Sehore" (6 chars), reason provided
>
> **previewToken:** `a3f9c1d8e2b40756`
> Reply "confirm" and I'll submit it unchanged.

**"Is my leave approved yet?"**

> **L9000001** · WINTER VACATION · Home
> 30 Oct 17:00 → 15 Nov 21:00 (17 days)
> Status: **PROCTOR APPROVAL PENDING** — raised, not yet actioned.
> Gate Pass OUT/IN not issued.

---

## Install

Needs **Node.js 20.6 or newer** (`node -v`) and **git**.

```bash
git clone https://github.com/CipherxHub/vtop-bhopal-mcp.git
cd vtop-bhopal-mcp
npm install
npm run build
```

`dist/` is not committed, so the build step is required.

Prefer hosted? Use it straight from Glama — no clone or build needed:

[![vtop-bhopal-mcp MCP server – quality and maintenance score on Glama](https://glama.ai/mcp/servers/CipherxHub/vtop-bhopal-mcp/badges/card.svg)](https://glama.ai/mcp/servers/CipherxHub/vtop-bhopal-mcp)

### Your credentials

Create a `.env` in the project folder with **your own** VTOP login
(full details, including the Windows equivalent of `chmod 600`, are in
[Connect it](#connect-it)):

```bash
VTOP_USERNAME=your-registration-number
VTOP_PASSWORD=your-vtop-password
```

It's gitignored and never committed. If you skip this, the assistant asks you in the chat the first time it needs them.

See [`.env.example`](.env.example) for the full list of optional settings.

---

## Connect it

Three steps for every client: build the server, create the `.env`, paste the
config. Replace `/path/to/vtop-bhopal-mcp` with where you cloned it. In JSON
files, use **forward slashes** (`D:/vtop-bhopal-mcp/…`) — backslashes need
escaping and are the commonest reason a pasted config silently fails.

### 1. Build

```bash
git clone https://github.com/CipherxHub/vtop-bhopal-mcp.git
cd vtop-bhopal-mcp
npm install        # run ON the machine that will use it — see note below
npm run build
```

`dist/` is not committed, so the build step is required. Never copy
`node_modules/` between machines: `sharp` ships a platform-specific native
binary, so an install copied from Windows will not start on macOS/Linux (and
vice versa). `npm install` on the target machine is the fix.

### 2. Credentials

Create a `.env` in the project folder with **your own** VTOP login:

```bash
VTOP_USERNAME=your-registration-number
VTOP_PASSWORD=your-vtop-password
```

It's gitignored and never committed. Then lock it down: `chmod 600 .env` on
macOS/Linux. That command is a no-op on Windows — use this instead so other
local users cannot read your password:

```powershell
icacls .env /inheritance:r /grant:r "$env:USERNAME:(F)" "BUILTIN\Administrators:(F)" "NT AUTHORITY\SYSTEM:(F)"
```

If you skip the `.env`, the assistant asks you in the chat the first time it
needs credentials. See [`.env.example`](.env.example) for the full list of
optional settings.

> **Where each client reads settings from.** The server never reads a `.env`
> by itself — something has to hand it the variables. For every client below
> except Codex, that something is Node's `--env-file=` flag in the pasted
> command, so the `.env` you just made is what gets loaded. **Codex is the
> exception:** it has no `--env-file` mechanism, so credentials (and
> `VTOP_CAPTCHA_OPEN`) go in its own config file's `env` block instead. A
> `.env` sitting next to the server is silently ignored by Codex.

### 3. Paste the config

**OpenCode** — global config, so it works in every project:

| OS | File |
|---|---|
| Windows | `C:\Users\<you>\.config\opencode\opencode.jsonc` |
| macOS / Linux | `~/.config/opencode/opencode.jsonc` |

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "vtop": {
        "type": "local",
        "command": [
          "node",
          "--env-file=/path/to/vtop-bhopal-mcp/.env",
          "/path/to/vtop-bhopal-mcp/dist/index.js"
        ]
      }
    }
  }
}
```

Then `opencode service restart`, start a **new chat** (tools load at session
start), and check with `opencode mcp list` — you want `✓ vtop connected`.

**Codex CLI** — easiest via its own command (it writes the file for you):

```powershell
codex mcp add vtop `
  --env VTOP_USERNAME=your-registration-number `
  --env VTOP_PASSWORD=your-vtop-password `
  --env VTOP_BASE_URL=https://vtop.vitbhopal.ac.in/vtop `
  -- node D:/vtop-bhopal-mcp/dist/index.js
```

That lands in `C:\Users\<you>\.codex\config.toml` on Windows
(`~/.codex/config.toml` on macOS/Linux) as:

```toml
[mcp_servers.vtop]
command = "node"
args = ['D:/vtop-bhopal-mcp/dist/index.js']

[mcp_servers.vtop.env]
VTOP_BASE_URL = "https://vtop.vitbhopal.ac.in/vtop"
VTOP_USERNAME = "your-registration-number"
VTOP_PASSWORD = "your-vtop-password"
```

Check with `codex mcp list`. **Quit Codex completely** (all windows — the
background process holds the old server open), relaunch, and start a new chat.
Optional safety guard — prompt before every login:

```toml
[mcp_servers.vtop.tools.login]
approval_mode = "approve"
```

**Claude Code:**

```bash
claude mcp add vtop -s user -- node --env-file=/path/to/vtop-bhopal-mcp/.env /path/to/vtop-bhopal-mcp/dist/index.js
```

Check with `claude mcp list`, then start a new chat.

**Claude Desktop** — same `command` + `args` shape in its config file:

| OS | File |
|---|---|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "vtop": {
      "command": "node",
      "args": ["--env-file=/path/to/vtop-bhopal-mcp/.env", "/path/to/vtop-bhopal-mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop after editing.

**Cursor** — global `~/.cursor/mcp.json`, or `<project>/.cursor/mcp.json` for
one workspace. Same `mcpServers` shape as Claude Desktop above.

**VS Code** — workspace file `.vscode/mcp.json` (top-level key is `servers`
here, not `mcpServers`), or run `MCP: Open User Configuration` from the
command palette for all workspaces:

```json
{
  "servers": {
    "vtop": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/vtop-bhopal-mcp/dist/index.js"],
      "envFile": "/path/to/vtop-bhopal-mcp/.env"
    }
  }
}
```

VS Code reads `envFile` natively, so no `--env-file` flag is needed. Check
with `MCP: List Servers`.

**Antigravity** — global `~/.gemini/config/mcp_config.json`, or
`.agents/mcp_config.json` inside one workspace (or open the agent panel
`…` → MCP Servers → Manage MCP Servers → View raw config):

```json
{
  "mcpServers": {
    "vtop": {
      "command": "node",
      "args": ["/path/to/vtop-bhopal-mcp/dist/index.js"],
      "env": {
        "VTOP_USERNAME": "your-registration-number",
        "VTOP_PASSWORD": "your-vtop-password",
        "VTOP_BASE_URL": "https://vtop.vitbhopal.ac.in/vtop"
      }
    }
  }
}
```

---

## Troubleshooting

Every entry below was hit on a real machine during testing — symptom, cause,
fix.

**1. `✗ vtop failed` the moment you add it.**
Node *exits* on a missing `--env-file` instead of ignoring it. Create the
`.env` first, or drop the `--env-file=…` argument until the file exists.

**2. `Request timed out` (OpenCode), log says `unknown message ID`.**
You set `cwd` on the server entry. It connects from some directories and
times out from others. Remove `cwd` — the server resolves every path
absolutely, so it buys nothing.

**3. `opencode mcp add` rejects `--env-file` (`Unrecognized flag`).**
As of v2.0.28 the CLI cannot pass it even after `--`. Hand-edit the JSON
instead, exactly as shown above.

**4. The captcha image is not visible.**
Some clients drop MCP `image` content blocks (confirmed: Codex's TUI,
OpenCode's plain TUI). `get_captcha` always writes the JPEG to disk and
returns the absolute path as `captchaFile` (default `%TEMP%\vtop-mcp-captcha\`,
override with `VTOP_CAPTCHA_DIR`), so open that file and read it. **Never let
the model guess the characters** — a wrong guess is a real failed login
attempt, and VTOP locks accounts after repeated failures.
*Hands-free option (experimental branch):* `VTOP_CAPTCHA_OPEN=1` makes the
server open the image in a viewer the moment it is written. Put it in the
`.env` for clients launched with `--env-file`, or in Codex's
`[mcp_servers.vtop.env]` block. Local single-user use only — on a shared
connector every call would pop a window on whoever is at the keyboard.

**5. `INVALID_CAPTCHA` over and over.**
The image expires in 30–60 seconds, and a slow round trip can outlast it. Ask
for a fresh captcha and answer fast. After three consecutive rejections the
server stops you itself and asks for a human — that is the safety stop
working, not a bug. Do not hammer retries: repeated failures escalate VTOP's
risk scoring toward `MAX_LOGIN_ATTEMPTS`, which needs a browser reset.

**6. `UPSTREAM: Request failed with status code 404` on `get_captcha`,
especially right after logout.**
Fixed on this branch: `logout()` used to keep the dead session cookie, and
VTOP 404s a `/login` that carries it. Update, rebuild, restart your client.
If you are on `main` without the fix, restarting the client process also
clears it.

**7. `RECAPTCHA_REQUIRED` — VTOP shows Google reCAPTCHA instead of the image.**
VTOP's risk score for your IP/session is high (common after several rapid
logins). Wait a while before retrying. A residential proxy via
`VTOP_PROXY_URL` also helps; datacentre IPs reliably trigger it.

**8. `npm run test:all` fails on `openssl` / native modules.**
The suite needs `openssl` for its local HTTPS mock — on Windows that comes
with Git for Windows. And `sharp` compiles per platform: always run
`npm install` on the machine itself, never copy `node_modules` across.

**9. Config change not picked up / stale tool list.**
MCP servers start with the client session. New chat after any config edit;
full client restart after `config.toml` / Desktop JSON edits;
`opencode service restart` for OpenCode. A stale server process also pins old
code — rebuilding `dist/` does nothing to a process that already loaded it,
so kill leftovers after every rebuild.

**10. `apply_leave`, `cancel_leave` and approvals.**
Of the 35 tools, 33 are read-only. `apply_leave` submits a real hostel leave
application to your proctor and `cancel_leave` withdraws one — both two-step (preview returns a token, confirm
repeats the identical target plus that token), but live writes all the same.
Keep approval prompts on for them (and for `login`) in clients that support
them, and never share a `.env` or a `config.toml` holding someone else's
credentials: the account behind them is the one VTOP sees.

---

## Tools at a glance

| | Tool | What it does |
|---|---|---|
| 🎓 | `get_attendance` | Attended / total / percentage per course |
| 🎓 | `get_attendance_detail` | Per-class present/absent per day, or NOT POSTED |
| 🎓 | `calculate_attendance` | How many classes you can still skip (or must attend) to hold 75% |
| 🎓 | `get_today_classes` | Today's classes — times and rooms, holiday-aware |
| 🎓 | `get_timetable` | Registered courses, slots, venues, faculty, credits |
| 📝 | `get_marks` | CAT and internal-assessment marks with weightage |
| 📝 | `get_internal_totals` | Marks banked per course, plus everything still to come |
| 📝 | `get_exam_schedule` | CAT-1, CAT-2, FAT — dates, sessions, venues, seats |
| 📝 | `check_pass_eligibility` | What you must score to pass, in **both** scales |
| 📊 | `get_semester_grades` | Grades and GPA for one semester |
| 📊 | `get_grade_history` | CGPA, credits, courses grouped by exam month |
| 📊 | `get_curriculum_progress` | Credits earned vs required, by category |
| 📊 | `get_course_basket` | Which basket a course is in, and its credits |
| 🔍 | `search_faculty` | Faculty directory search with detail cards (department, email, cabin) |
| 📄 | `get_course_syllabus` | Downloads a course's syllabus PDF, returns the saved file path |
| 🗓 | `get_calendar` | Holidays, exams, events, instructional days |
| 🗓 | `get_semester_info` | Term bounds, days left, teaching-over flag |
| 🗓 | `get_semesters` | All your semesters and their IDs |
| 🗓 | `get_profile` | Name, registration number, programme, branch, plus photo file |
| 🏠 | `get_leave_types` | Leave types VTOP currently offers |
| 🏠 | `get_leave_status` | Your leave applications and approval status |
| 🔐 | `session_status` | Whether you're logged in and whether VTOP agrees |
| 🔐 | `get_captcha` · `login` · `logout` | Signing in and out |
| ⚠️ | **`apply_leave`** | **Submits a real leave application** — two-step, see above |
| ⚠️ | **`cancel_leave`** | **Withdraws an applied leave** — two-step, see above |
| 🔍 | `get_leave_type_rules` | Probes VTOP for per-type rules. Never submits |

Full reference, including arguments and return shapes: **[docs/tools.md](docs/tools.md)**.

### Two things it deliberately won't do

**No grade or GPA predictor.** VIT awards letter grades *relatively* — against the class average and its spread — and VTOP exposes neither. Any prediction would be you supplying a guess and getting a guess back. `get_grade_history` reports the grades VTOP actually awarded; `check_pass_eligibility` reports the thresholds the published pass rules impose. Nothing extrapolates.

**Read the percentages in `get_internal_totals` carefully.** VTOP omits components that haven't happened yet rather than showing them as zero, and the internal scale isn't a constant 50. Marks scored are exact; **percentages are a lower bound.** The tool repeats this note on every call.

---

## Docs

| | |
|---|---|
| [docs/tools.md](docs/tools.md) | All 35 tools — arguments, returns, read/write |
| [docs/hostel-leave.md](docs/hostel-leave.md) | Leave types, rules, the two-step confirmation |
| [docs/http-connector.md](docs/http-connector.md) | Hosting it remotely, and its security model |
| [docs/errors.md](docs/errors.md) | Error codes, recovery paths, troubleshooting |
| [docs/bhopal-vtop.md](docs/bhopal-vtop.md) | How Bhopal's markup and endpoints actually behave |
| [docs/development.md](docs/development.md) | Architecture, tests, adding a tool |
| [docs/provenance.md](docs/provenance.md) | What came from where, with line counts |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Fixture hygiene — synthetic data only |

---

## Privacy

- **Your login only goes to VTOP.** The server runs on your machine and talks directly to `vtop.vitbhopal.ac.in`. It never sends your credentials anywhere else.
- **Nothing is stored.** Session cookies live in memory and vanish when the server stops. Your password stays in your own `.env`, if you create one.
- **Your assistant sees your data.** Whatever the tools return goes to the AI client you connected — the same as anything else you ask it.
- **This repo contains no student data.** No registration numbers, no marks, no CGPA, no leave ids. `npm run test:privacy` enforces that on every file, and it will fail the build if real data ever appears.

---

## Limitations

- **Unofficial.** Not affiliated with or endorsed by VIT Bhopal. It reads the same pages your browser does — if VTOP changes them, parts break until updated.
- **Two tools write.** See [docs/hostel-leave.md](docs/hostel-leave.md). Everything else only reads; it never registers courses, changes marks, or touches fee and payment pages.
- **Leave duration limits are partly unknown.** VTOP enforces them server-side and publishes none. Only Home Town ≤ 14 days is confirmed. Guessing the rest would block valid requests, so it isn't attempted.
- **Exam overlap is a warning, not a block.** A clash is sometimes unavoidable and isn't this tool's decision to make.
- **Bunk calculator assumes 75%.** Check your own course rules.
- **The HTTP connector is tested, including a live login.** 20 offline checks cover routing, auth, CORS, the MCP transport and page content; it refuses every unauthenticated request; and a full register → captcha → login → real-data pass was run against VTOP on 13 Oct 2026. What remains untested is the *network path* — whether VTOP serves a Google reCAPTCHA to your host's IP range, which is a property of where you deploy. Recipe and security notes: [docs/http-connector.md](docs/http-connector.md).

---

## Provenance

Built on earlier work, with each layer credited and sized:

| Layer | Author | Licence | Scale |
|---|---|---|---|
| Original architecture and most parsers | [Vikranth Jagdish](https://github.com/Vikranth-jagdish/VtopMCP) | MIT | ~43% inherited |
| Bhopal parser adaptations | [divyarthjain](https://github.com/divyarthjain/vtop-bhopal-mcp) | Apache-2.0 | ~247 lines, 5 files |
| Leave, pass rules, errors, cache | [CipherxHub](https://github.com/CipherxHub) | Apache-2.0 | ~2,563 new lines |

Behavioural reference only (no code copied): [android-vtop-chennai](https://github.com/therealsujitk/android-vtop-chennai), GPL-3.0.

Full detail, including why only one MIT notice is reproduced: **[docs/provenance.md](docs/provenance.md)**. Licence texts: [LICENSE](LICENSE), [NOTICE](NOTICE), [LICENSE-MIT-upstream](LICENSE-MIT-upstream).

Not affiliated with or endorsed by VIT Bhopal University.
