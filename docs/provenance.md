# Provenance

Where every part of this codebase came from, with sizes measured by diffing
against both upstream projects rather than estimated.

Short version: roughly **43% is inherited from Vikranth Jagdish's VtopMCP**, about
**247 lines** come from divyarthjain's Bhopal adaptations, and about **2,563
lines** were written for this project — plus all of the live testing that
produced the Bhopal-specific behaviour encoded in them.

> Every number here is measured against the upstream repos, not estimated. See
> [Reproducing these numbers](#reproducing-these-numbers) at the end.

---

## The chain

```
Vikranth Jagdish          Vikranth-jagdish/VtopMCP        MIT
  original architecture, VTOP client, parsers, HTTP connector
        │
        │  relicensed to Apache-2.0
        ▼
divyarthjain              divyarthjain/vtop-bhopal-mcp    Apache-2.0
  Bhopal parser adaptations (+247 lines across 5 files)
        │
        │  continued
        ▼
CipherxHub               CipherxHub/vtop-bhopal-mcp      Apache-2.0
  leave tools, pass-eligibility arithmetic, error taxonomy, cache, keepalive,
  captcha upscaling, structured errors, 294 offline checks
  and all testing against the live portal
```

`android-vtop-chennai` (GPL-3.0) informed the *approach* — see
[Behavioural reference](#behavioural-reference) below.

---

## Measured contribution

### Vikranth Jagdish — VtopMCP (MIT)

`src` grew from 4,623 lines in VtopMCP to 8,283 here. Six files are
**byte-for-byte identical** to his:

| File | Lines | What it is |
|---|---:|---|
| `src/services/attendance-calc.ts` | 265 | Attendance projection formulas |
| `src/services/session-store.ts` | 168 | Cookie/session handling |
| `src/tools/attendance-calc.ts` | 83 | Tool wrapper |
| `src/tools/calendar.ts` | 54 | Calendar tool |
| `src/services/concurrency.ts` | 22 | Request pool |
| `src/tools/curriculum.ts` | 17 | Curriculum tool |
| **Total** | **609** | |

Of the 8,283 lines now in `src`, **609 sit inside files that are
byte-for-byte unchanged** — 7.4%. An earlier version of this file quoted 43.3%
by measuring "lines not added relative to upstream", which counts a modified
file as if none of it were inherited. That overstates it badly and has been
replaced with the figure that can be verified directly.

Three files were byte-identical when this fork started and are **no longer**:

- `src/http.ts` and `src/web.ts` — both substantially rewritten (auth now fails
  closed, JSON instead of SSE, CORS off by default, loopback bind; the landing
  page rewritten for multiple clients).
- `src/services/crypto.ts` — the AES-256-GCM scheme and the scrypt KDF are
  still his, but token expiry (`iat`/`exp`) was added, so it is no longer a
  copy.

They remain *derived from* his work and are covered by the MIT notice. Being
derived is not the same as being a copy, and the distinction is what makes the
percentage above meaningful.

`src/services/tls.ts` also differs, but only in its doc-comment, which records
that VIT Bhopal's certificate chain verifies unaided. The executable code is
unchanged.

This code cannot be claimed as original here. It is his expression — the
attendance projection formulas and the AES token scheme could not be reproduced
from a specification, which is exactly what makes them copyrightable.

### divyarthjain — vtop-bhopal-mcp (Apache-2.0)

Diffing their repo against VtopMCP shows what they changed:

| File | Added | Removed |
|---|---:|---:|
| `src/services/vtop-parser.ts` | +209 | −153 |
| `src/tools/profile.ts` | +11 | −2 |
| `src/services/constants.ts` | +10 | −3 |
| `src/services/vtop-client.ts` | +1 | −1 |
| **Total** | **+247** | −170 |

Those adaptations — the `<th>`-less attendance header, the "General (Semester)"
exam row, multi-group calendar entries, the timetable `sessions` merge — are
still load-bearing here: **1,012 of the current parser's 1,211 lines are
byte-identical to their version.**

That is ~3% of the codebase. It is credited because Apache-2.0 §4(d) requires
carrying forward upstream `NOTICE` attribution when you include their code — not
because it was a major contribution. `docs/provenance.md` says so explicitly so
the credit is neither inflated nor hidden.

### CipherxHub — original work

Ten files with no upstream counterpart, 2,784 lines:

| File | Lines | What it does |
|---|---:|---|
| `src/services/leave.ts` | 643 | Leave validation, 18:00 rule, fingerprints, class + exam overlap |
| `src/tools/leave.ts` | 486 | The four leave tools |
| `src/services/exam-eligibility.ts` | 453 | Pass arithmetic in both scales, 80-of-200 conservation |
| `src/services/marks-calc.ts` | 385 | Internal totals, pending components, the lower-bound caveat |
| `src/tools/pass-eligibility.ts` | 294 | Tool surface for the above |
| `src/services/errors.ts` | 195 | 13 structured error codes with recovery chains |
| `src/services/captcha-image.ts` | 112 | 5× captcha upscaling |
| `src/services/cache.ts` | 80 | Bounded TTL cache |
| `src/services/keepalive.ts` | 69 | Session keepalive |
| `src/services/captcha-file.ts` | 67 | Captcha file fallback for clients that drop `image` blocks |
| **Total** | **2,784** | |

Plus substantial edits to inherited files: `vtop-parser.ts` (404 lines changed
against VtopMCP), `vtop-client.ts`, `http.ts` (auth, transport, CORS, bind),
`web.ts`, `schemas/index.ts`, `types/index.ts` — and the test suite, which grew
from none to **294 offline checks**.

The two line totals in this file measure different things on purpose. **2,784**
is the code in files that do not exist upstream at all, so it is original by
construction. **609** is the code inside files that are byte-for-byte unchanged,
so it is inherited by construction. The remainder is inherited code that was
subsequently edited, and no honest figure describes it — most of it is still his.

---

## What is *not* attributable — testing and domain knowledge

A large part of the effort here is invisible in a line count, and it is worth
being precise about why it cannot be claimed as authorship:

**Live testing** produced the facts encoded throughout `src/services` — that
VTOP's attendance header row carries no `<th>`, that the exam table has a
"General (Semester)" row above its header, that leave lives at
`hostels/student/leave/1..4` and not under the guessed `hostel/*` paths, that
HTTP 200 is used for failure pages. These are **facts about a remote system**.
Anyone running the same probes discovers them. Facts are not copyrightable
expression.

**Domain knowledge** — the 80-of-200 pass rule, the 18:00 Day Outing deadline,
Home Town ≤ 14 days — are **rules VIT imposes**, not inventions here.

This is not a comment on the effort. It is why the honest claim is "I extended
and verified this", not "I wrote this". The line counts above are checkable, and
that is what makes them credible.

---

## Why only one MIT notice is reproduced

`LICENSE-MIT-upstream` names **only Vikranth Jagdish**. That is deliberate.

MIT's condition reads: *"The above copyright notice and this permission notice
shall be included in all copies or substantial portions of the Software."* The
obligation runs from **a specific copyright holder**, over **their** code.
Notices are not merged and you cannot list a holder who did not hold copyright
in the code present.

VtopMCP is the only one of the three projects whose *code* is in this repository,
and Vikranth Jagdish is its sole named copyright holder. One notice therefore
covers 100% of the MIT-licensed code here. divyarthjain's contribution is
Apache-2.0, which has no verbatim-notice requirement — its obligation is §4(d)
carry-forward, satisfied by this file and `NOTICE`.

---

## Behavioural reference

`android-vtop-chennai` is **GPL-3.0**. It is credited because the approach to
talking to VTOP came from observing how that app works.

**No code from it is present.** It is a Kotlin/Java Android application; this is
TypeScript. Nothing could be transplanted between them. What was taken is
behavioural: which endpoints exist, how the prelogin handshake is sequenced,
what the response markup looks like.

Endpoint paths and protocol sequences are **facts about a remote system**, not
copyrightable expression, and Apache-2.0 §4(d) expressly contemplates this — it
asks you to carry attribution forward, which `NOTICE` does.

This matters because GPL-3.0 is copyleft. Had any code been copied, this project
would have to be distributed as GPL-3.0 and could not be Apache-2.0. **This
project is Apache-2.0**, so the no-code-copied position is load-bearing, not
decorative.

> Not a legal opinion. If you need certainty before accepting outside
> contributions, commission a licence audit.

---

## Licence compatibility

MIT → Apache-2.0 is a permitted upgrade: MIT is permissive, and Apache-2.0 adds a
patent grant without adding copyleft. Apache-2.0 §3 permits incorporating
MIT-licensed code, and those portions stay MIT — which is why both licence texts
ship in this repository and both apply simultaneously to different files.

Apache-2.0 grants use, modification, sublicensing and commercial use without
restriction. The upstream authors cannot revoke that. The only condition is
attribution, and it is met.

---

## Reproducing these numbers

```bash
git clone --depth 1 https://github.com/Vikranth-jagdish/VtopMCP.git /tmp/upstream
git clone --depth 1 https://github.com/CipherxHub/vtop-bhopal-mcp.git /tmp/here

# what changed upstream -> here
git diff --no-index --numstat /tmp/upstream/src /tmp/here/src

# files that are byte-for-byte unchanged
for f in $(cd /tmp/here/src && find . -name '*.ts'); do
  [ "$(sha256sum "/tmp/here/src/$f" | cut -d' ' -f1)" = \
    "$(sha256sum "/tmp/upstream/src/$f" 2>/dev/null | cut -d' ' -f1)" ] \
    && echo "identical  $f"
done
```

---

## Licences

| File | Covers |
|---|---|
| [LICENSE](../LICENSE) | Apache-2.0 — this project's own code |
| [LICENSE-MIT-upstream](../LICENSE-MIT-upstream) | MIT — VtopMCP code, © Vikranth Jagdish |
| [NOTICE](../NOTICE) | Required attribution notices |

Not affiliated with, endorsed by, or supported by VIT Bhopal University or VIT.
