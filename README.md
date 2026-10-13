# VTOP Bhopal MCP

> Ask your AI assistant anything about your **VIT Bhopal** VTOP account — attendance, marks, timetable, exams, grades, pass eligibility, hostel leave — in plain language.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
![Node 20.6+](https://img.shields.io/badge/node-%E2%89%A520.6-brightgreen)
![MCP](https://img.shields.io/badge/MCP-stdio-purple)

An [MCP](https://modelcontextprotocol.io) server. Connect it to OpenCode, Claude Code, Claude Desktop, Cursor or anything else that speaks MCP, then just ask. It signs in to VTOP, reads the page, and answers.

> ### ⚠️ Exactly one tool writes to your account
>
> Of the 23 tools, **22 are strictly read-only.** One is not: **`apply_leave`** submits a real hostel leave application for your proctor. That is the only write.
>
> It cannot fire by accident. It is two-step — a **preview** call validates and returns a fingerprint token without sending anything, and a **confirm** call must repeat the identical fields *and* that token. Change any field in between and it's refused. It also declares `readOnlyHint: false` so a compliant client prompts rather than auto-approving.
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

### Your credentials

Create a `.env` in the project folder with **your own** VTOP login:

```bash
VTOP_USERNAME=your-registration-number
VTOP_PASSWORD=your-vtop-password
```

Then `chmod 600 .env`. It's gitignored and never committed. If you skip this, the assistant asks you in the chat the first time it needs them.

See [`.env.example`](.env.example) for the full list of optional settings.

---

## Connect it

Replace `/path/to/vtop-bhopal-mcp` with where you cloned it.

**Claude Code**

```bash
claude mcp add vtop -s user -- node --env-file=/path/to/vtop-bhopal-mcp/.env /path/to/vtop-bhopal-mcp/dist/index.js
```

**Claude Desktop / Cursor / Windsurf / Cline** — same `command` + `args` shape in your client's MCP config file:

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

**OpenCode** — V2 uses `mcp.servers`, and `command` is an **array**:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "vtop": {
        "type": "local",
        "command": ["node", "D:/vtop-bhopal-mcp/dist/index.js"],
        "cwd": "D:/vtop-bhopal-mcp"
      }
    }
  }
}
```

> **No `.env`?** Drop the `--env-file=…` argument. Node *exits* on a missing env file rather than ignoring it, which shows up as `✗ vtop failed` — so only add the flag once the file exists.

Then **start a new chat** (tools load at session start) and ask something.

Check it worked with `claude mcp list` (Claude Code) or `opencode mcp list` (OpenCode). If the tool list looks stale in OpenCode, run `opencode service restart`.

---

## Tools at a glance

| | Tool | What it does |
|---|---|---|
| 🎓 | `get_attendance` | Attended / total / percentage per course |
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
| 📊 | `calculate_od` | OD days used this semester vs the limit |
| 🗓 | `get_calendar` | Holidays, exams, events, instructional days |
| 🗓 | `get_semesters` | All your semesters and their IDs |
| 🗓 | `get_profile` | Name, registration number, programme, branch |
| 🏠 | `get_leave_types` | Leave types VTOP currently offers |
| 🏠 | `get_leave_status` | Your leave applications and approval status |
| 🔐 | `session_status` | Whether you're logged in and whether VTOP agrees |
| 🔐 | `get_captcha` · `login` · `logout` | Signing in and out |
| ⚠️ | **`apply_leave`** | **Submits a real leave application** — two-step, see above |
| 🔍 | `get_leave_type_rules` | Probes VTOP for per-type rules. Never submits |

Full reference, including arguments and return shapes: **[docs/tools.md](docs/tools.md)**.

### Two things it deliberately won't do

**No grade or GPA predictor.** VIT awards letter grades *relatively* — against the class average and its spread — and VTOP exposes neither. Any prediction would be you supplying a guess and getting a guess back. `get_grade_history` reports the grades VTOP actually awarded; `check_pass_eligibility` reports the thresholds the published pass rules impose. Nothing extrapolates.

**Read the percentages in `get_internal_totals` carefully.** VTOP omits components that haven't happened yet rather than showing them as zero, and the internal scale isn't a constant 50. Marks scored are exact; **percentages are a lower bound.** The tool repeats this note on every call.

---

## Docs

| | |
|---|---|
| [docs/tools.md](docs/tools.md) | All 23 tools — arguments, returns, read/write |
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
- **One tool writes.** See [docs/hostel-leave.md](docs/hostel-leave.md). Everything else only reads; it never registers courses, changes marks, or touches fee and payment pages.
- **Leave duration limits are partly unknown.** VTOP enforces them server-side and publishes none. Only Home Town ≤ 14 days is confirmed. Guessing the rest would block valid requests, so it isn't attempted.
- **Exam overlap is a warning, not a block.** A clash is sometimes unavoidable and isn't this tool's decision to make.
- **The OD limit is unconfirmed.** `calculate_od` counts against 8, based on students' understanding that ~8–9 event ODs are allowed and DSW-approved ODs are unlimited. VTOP doesn't mark which were DSW-approved. Verify with your school or the DSW office.
- **Bunk calculator assumes 75%.** Check your own course rules.
- **The HTTP connector is tested offline but not yet live.** Its routing, auth, CORS, MCP transport and page content are covered by 18 offline checks, and it refuses every unauthenticated request. But no real login has been run through it against VTOP, so treat that as unproven rather than absent. Details and the safe-deployment recipe: [docs/http-connector.md](docs/http-connector.md).

---

## Provenance

Built on earlier work, with each layer credited and sized:

| Layer | Author | Licence | Scale |
|---|---|---|---|
| Original architecture and most parsers | [Vikranth Jagdish](https://github.com/Vikranth-jagdish/VtopMCP) | MIT | ~40% inherited |
| Bhopal parser adaptations | [divyarthjain](https://github.com/divyarthjain/vtop-bhopal-mcp) | Apache-2.0 | ~247 lines, 5 files |
| Leave, pass rules, errors, cache | this project | Apache-2.0 | ~2,127 new lines |

Behavioural reference only (no code copied): [android-vtop-chennai](https://github.com/therealsujitk/android-vtop-chennai), GPL-3.0.

Full detail, including why only one MIT notice is reproduced: **[docs/provenance.md](docs/provenance.md)**. Licence texts: [LICENSE](LICENSE), [NOTICE](NOTICE), [LICENSE-MIT-upstream](LICENSE-MIT-upstream).

Not affiliated with or endorsed by VIT Bhopal University.
