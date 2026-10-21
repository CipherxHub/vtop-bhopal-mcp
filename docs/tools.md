# Tool reference

35 tools. **33 read-only, 2 write.** Argument schemas below are the real ones
from `src/schemas/index.ts` — this file is generated from the same source the
server validates against.
---

## Shared arguments

Most per-semester tools take `SemesterInputSchema`:

| Field | Type | Meaning |
|---|---|---|
| `semesterId` | `string?` | e.g. `BL20262701`. **Omitted = current semester**, which is almost always what you want. |
| `refresh` | `boolean?` | Bypass the 60-second cache and re-read from VTOP. Set this when you specifically need to know whether something was *just* updated. |

Results are cached for 60 seconds so follow-up questions are instant. Without
`refresh`, asking twice in a minute returns the same snapshot.

---

## Attendance

### `get_attendance`

Attended / total / percentage per course.

**Args:** `semesterId?`, `refresh?`

> Any of the three numbers may be `null`: VTOP prints `-`/blank for courses
> with no figures yet, and that reads as *unknown*, never as zero. Courses
> with `null` counts are reported without projections (`currentPercent: null`,
> no deadline math) rather than as debarred.

### `get_attendance_detail`

Per-class sessions for one course: date and outcome per posted class
(Present / Absent / On Duty). Ask "was I present on 2026-10-12 in BCSE302L?"
with `courseCode` + `date`; omit `date` to list every posted session. A date
with no row means VTOP posted nothing for it — NOT POSTED, never absent.

**Args:** `semesterId?`, `refresh?`, `courseCode`, `date?` — ISO `YYYY-MM-DD`

### `calculate_attendance`

The bunk calculator. How many more classes you can skip, or must attend, to hold
a target percentage.

| Field | Type | Meaning |
|---|---|---|
| `semesterId` | `string?` | Default: current semester |
| `courseCode` | `string?` | One course (case-insensitive). Omit for all. |
| `targetPercent` | `number?` | 0–100. **Default 74** — VIT requires 75, but 74.x rounds up. |
| `untilDate` | `string?` | ISO date to project to (e.g. a CAT-2 cutoff). Uses the timetable grid + academic calendar: working days, holidays, working Saturdays, day-orders. |
| `includeUntilDate` | `boolean?` | Count classes **on** the closing date. Default `true`. |
| `bunkDates` | `string[]?` | Dates you plan to skip. Requires `untilDate`. Reports whether you'd still be safe by the close if you skip exactly those and attend everything else. |
| `toTermEnd` | `boolean?` | Project to the last instructional day of the term automatically (from the calendar) instead of passing `untilDate`. When teaching is over, returns the figures as final (locked) with no projection. |

`untilDate` and `bunkDates` are what make this useful rather than arithmetic —
without them it can only divide numbers you already have.

### `get_timetable`

Registered courses with slots, venues, faculty and credits, plus the weekly
schedule. Each course carries a `sessions` array with every meeting it has
(day, slot, THEORY/LAB, start and end time, venue) — a course with two slots
a week appears twice. This is the tool that answers which faculty teaches
which of your subjects.

**Args:** `semesterId?`, `refresh?`

### `get_today_classes`

Today's classes (IST), or a given date.

**Args:** `date?` — ISO `YYYY-MM-DD`

Holiday-aware. Knows about Saturdays that follow another weekday's timetable
("Activities Friday") and working Saturdays that override the weekday.

### `get_marks`

Internal assessment marks per component — CAT-1, CAT-2, labs, quizzes,
assignments — with VTOP's own `weightage` column.

**Args:** `semesterId?`, `refresh?`

> A blank cell is unpublished, never zero: `scored`/`weightage` come back
> `null` with `pending: true`, and bank nothing into `scoredSoFar`. A real
> scored zero (e.g. an Absent) stays `0` with `pending: false`.

### `get_internal_totals`

What you've banked this semester, per course, plus everything still to come.

**Args:** `semesterId?`, `refresh?`

> **Read the percentages carefully.** The tool sums VTOP's `weightage` column,
> which VTOP has already scaled to the internal total. **Marks scored are exact.
> Percentages are a lower bound.** VTOP omits components that haven't happened
> yet rather than showing them as zero, and the internal scale is *not* a
> constant 50 — a course with labs and tutorials listed seven components
> totalling 65. Treat `scoredSoFar` as the number to trust. The returned `note`
> repeats this on every call.

### `get_exam_schedule`

CAT-1, CAT-2 and FAT: dates, sessions, times, venues, seats.

**Args:** `semesterId?`, `refresh?`

### `check_pass_eligibility`

What you must score to pass each course — reported in **both scales**, because
VTOP's marks are printed on paper but the rules are weighted:

- the **raw** scale, out of 200 (CAT-I 20 + CAT-II 20 + TEE 40)
- the **weighted** scale, on the 100-point course total

The pass rule is 80 of 200. The TEE contributes a base of 40/100, **plus** any
net shortfall in the CAT pair if the two together fall below 40. Both scales are
always stated, and the arithmetic conserves the 80 — a figure that satisfied one
scale would not silently fail the other.

**A CAT you did not attempt is a 20-mark hole, not a separate veto.** It scores
0, its share transfers to the TEE, and the course still passes if the TEE makes
the total up to 80. If the total still falls short, the *course* is failed and
VIT makes you re-register it — there is no re-test for a CAT, the TEE or the
course. A CAT you attempted and scored 0 in is the same hole with a different
reason.

Also reports which classes or exams a proposed leave would cost you.

**Args:** `semesterId?`, `refresh?`

---

## Grades

### `get_semester_grades`

Grades, grade points and GPA for one semester.

**Args:** `semesterId?`, `refresh?`

### `get_grade_history`

CGPA, cumulative credits earned vs required, and every course grouped by exam
month.

**Args:** none

### `get_curriculum_progress`

Degree progress: credits earned against those required, broken down by category
and basket.

**Args:** none

### `get_cgpa_target`

What the courses you have **left** must score to reach a target CGPA. Pass a
target (e.g. `8.5`) and it reports: your CGPA now, the target, the **maximum**
CGPA reachable if everything scores S, the CGPA if everything fails, the
average grade points needed, and a **concrete mix** (e.g. "2 S and 2 A") that
lands you on the target. If the target is out of reach it says so instead of
pretending.

**Args:** `target` — 0–10

### `get_cgpa_impact`

What a specific set of grades does to your CGPA. Pass `courseCode → grade` for
the courses you have left (`{"CSD3002": "A"}`) and it reports your CGPA now,
the CGPA if those grades land, the **difference**, and the range if they all
scored S or all failed.

**Args:** `grades` — course code → grade letter (`S`,`A`,`B`,`C`,`D`,`E`,`F`)

> Both tools are **requirements, not predictions**: they say what the remaining
> courses would have to score, never what you will score. VIT's scale is
> `S=10 A=9 B=8 C=7 D=6 E=5 F=0`; `P` (non-credit) courses carry no points
> and do not enter the denominator, and a course you **failed** keeps its
> credits in the denominator with zero points — VIT makes you re-register it,
> which adds those credits to the denominator again.

### `check_attendance_totals`

Does VTOP's own "total classes" match the sessions the timetable and academic
calendar imply? Per course: VTOP's total, the expected number of sessions, and
the difference. A difference is **information, not an error** — VTOP counts
classes its own way (cancelled sessions, late starts, make-up classes).

**Args:** `semesterId?`, `refresh?`

### `get_missed_classes`

Every class you have missed this semester: per course, the dates you were
absent (with the slot) and the total. On-duty is not an absence; a class VTOP
has not posted is unknown, not missed.

**Args:** `semesterId?`, `refresh?`, `courseCode?`

### `get_degree_summary`

The whole picture in one call: your CGPA, credits earned vs required, what is
still outstanding and from which basket, whether a target CGPA is still
reachable, and the next date that matters (your next exam, and when teaching
ends). Start here for "how far am I from finishing my degree?".

**Args:** `target?` — a target CGPA to test (e.g. `8.5`)

### `get_failed_courses_impact`

What each failed course costs, and what clearing it would buy: your CGPA now,
your CGPA if the course were not on the record, and your CGPA if you
re-register it and pass at the lowest passing grade. **The trap it exposes:**
re-registering adds the credits back into the denominator, so clearing a
backlog can *lower* your CGPA unless you pass well — the tool names the
lowest grade that would actually help.

**Args:** none

### `get_curriculum_baskets`

Programme curriculum baskets: every category (Programme Core, Programme
Elective, University Core/Electives, …) with its courses — code, title, type,
version, L/T/P/J and credits. Each row carries `vtopMarkedCompleted`, VTOP's
own completion marking, reported verbatim.

**Args:** none

### `get_course_basket`

Which curriculum basket a course belongs to: pass a course code
(`CSD3002`) or title fragment (`salesforce`) and get every matching
catalogue course with its basket (Programme Core, Programme Elective, …),
credits and completion state. Reads the programme catalogue, so it works
for courses never taken.

**Args:** `query`

### `get_pending_subjects`

Subjects still to complete, with names and credits: the curriculum baskets
minus grade-history passes. Completion is decided ONLY by course code against
the latest grade on record (a pass is any grade except F; N never counts).
Period labels are never compared — timetable labels are instructional
semesters while grade-history labels are result-publication months. Any
disagreement between VTOP's own marking and grade history lands in
`discrepancies` and is never resolved silently. Leftovers are also grouped
by basket (`byBasket`: pending courses, credits and completed/total counts
per basket).

Subjects still to complete, with names and credits: the curriculum baskets
minus grade-history passes. Completion is decided ONLY by course code against
the latest grade on record (a pass is any grade except F; N never counts).
Period labels are never compared — timetable labels are instructional
semesters while grade-history labels are result-publication months. Any
disagreement between VTOP's own marking and grade history lands in
`discrepancies` and is never resolved silently.

**Args:** none

> **No grade or GPA predictor exists, deliberately.** VIT awards letter grades
> *relatively* — against the class average and its spread — and VTOP exposes
> neither. A prediction would be you supplying a guess and getting a guess back.
> These tools report only what VTOP actually awarded.

---

## Calendar and profile

### `get_calendar`

| Field | Type | Meaning |
|---|---|---|
| `semesterId` | `string?` | Default: current. Events land in the term they fall in, so a Fall event needs the Fall semester id. |
| `month` | `string?` | `YYYY-MM` |
| `query` | `string?` | Case-insensitive name search (`technovit`, `pongal`) |
| `holidaysOnly` | `boolean?` | Only non-instructional days |
| `classGroup` | `string?` | Whose calendar: `COMB` (combined, default), `ALL`, `FS`, `FT` and programme variants. VTOP publishes the list per semester. |

### `get_semester_info`

Term bounds for a semester: id, name, first/last instructional day from the
academic calendar, instructional-day totals, days remaining, and whether
teaching is over. When `teachingOver` is true, no more classes can occur —
attendance figures are final (locked), not projectable.

**Args:** `semesterId?` (default: current)

### `get_semesters`

All your semesters and their IDs. Use this when you need a specific term.

**Args:** none

### `get_profile`

Name, registration number, application number, programme, branch, school, and
contact details — plus the profile photo saved to disk as `photoFile` (open
that file to see it). A null `photoFile` with a `photoNote` means VTOP served
no usable image; the text fields stand on their own.

**Args:** none

### `get_student_profile`

Full profile: the five accordion sections of VTOP's profile page (personal,
educational, family, proctor, hostel information), exactly as VTOP groups them
— date of birth, addresses, board/school, parents, proctor contact, hostel
block and room. Use this instead of `get_profile` for anything beyond the
basics.

**Args:** none

> **Privacy:** this returns sensitive PII (family names/phones, home address,
> DOB) verbatim. Don't paste it into issues or chats beyond the student's own
> session, and never enable `VTOP_DUMP_HTML` around it — dumps write raw pages
> to disk. The session cache holds the page until the server stops.

### `get_acknowledgments`

Admission document checklist with per-document status (Submitted, Not
Applicable, Not Submitted). A `Not Submitted` line names a document the student
still owes.

**Args:** none

### `get_proctor_details`

Proctor (faculty mentor) contact details: id, name, designation, school,
department, cabin, email, intercom, mobile. Same data as the proctor section
of `get_student_profile`, via the standalone proctor page.

**Args:** none

---

## Faculty and syllabus

### `search_faculty`

Faculty directory search with full details in one call (Academics →
Faculty Info). Every match carries name, designation and school, plus the
detail card: department, email, cabin (`null` when VTOP publishes none).

**Args:** `name` — fragment, minimum 3 characters, letters and spaces only
(mirrors VTOP's own search-box validation). Details are fetched for up to 10
matches; beyond that, refine the fragment.

> The search posts the fragment as `empId` (the search box's *id* is
> `searchEmployee`, but the page's `getEmployeeInfo()` sends `empId` — posting
> the box name returns the empty shell). Each row's Action button carries the
> employee id (numeric like `91001` or alphanumeric like `RST99`) in its id
> and `getEmployeeIdNo("…")` onclick; the detail call re-sends it as `empId`.

### `get_course_syllabus`

A course's syllabus PDF (My Curriculum → the download icon beside each
course code). Saves `syllabus-{CODE}.pdf` under `VTOP_DOWNLOAD_DIR` (default
OS temp dir) and returns the file path plus byte size — open the file to
read it, since tool results carry the path, not the bytes.

**Args:** `courseCode` — e.g. `CSD3010`

> The download is `GET courseSyllabusDownload1/{CODE}` with the standard auth
> query fields (the URL the page's `vtopDownload()` opens). VTOP answers
> failures as HTTP 200 HTML, so a non-`%PDF` answer fails loud instead of
> saving a fake `.pdf`.

---

## Hostel leave

Full documentation: **[hostel-leave.md](hostel-leave.md)**.

| Tool | Args | Writes? |
|---|---|---|
| `get_leave_types` | none | no — reads VTOP's live dropdown |
| `get_leave_status` | none | no |
| `get_leave_history` | none | no — full history incl. approved past leaves |
| `get_leave_type_rules` | `leaveCode?` | no — diagnostic probe |
| `apply_leave` | see below | **yes** |
| `cancel_leave` | see below | **yes** — withdraws an applied leave, two-step like `apply_leave` |

## Fees

### `get_fee_receipts`

Fee payment receipts: number, date, amount and campus per payment, plus the
total paid. Pass `receiptNo` (from a previous call; a bare number is shaped
to VTOP's `<no>/8/BPL` ref automatically) for that receipt's detail
breakdown instead of the list. Amounts are as printed, no conversion.

**Args:** `receiptNo?`

---

### `apply_leave`

| Field | Type | Meaning |
|---|---|---|
| `leaveCode` | `string` | **Code, not label.** `SO` `WP` `EP` `SV` `WV` `HT1` `LG1` `EY1` `OG1` |
| `visitingPlace` | `string` | Required, max 150 chars |
| `leaveFromDate` | `string` | ISO `YYYY-MM-DD`, not in the past |
| `fromTime` | `string` | `HH:MM` safest; `6:00 PM`, `1800`, `8.30` all normalise |
| `leaveToDate` | `string` | ISO `YYYY-MM-DD` |
| `toTime` | `string` | Same formats. For `OG1` must be ≤ 18:00 — **18:00 allowed, 18:01 refused** |
| `reason` | `string` | Required |
| `confirm` | `boolean?` | **Unset on the first call.** `true` + a token to actually submit |
| `previewToken` | `string?` | From the preview. Required with `confirm: true` |

Two-step: preview returns a server-signed, single-use `previewToken` (bound to
the exact fields and caller, 10-minute expiry) and sends nothing. Submitting
requires the identical fields plus that token. Edit any field and it's
refused. Declares `readOnlyHint: false` so a compliant client prompts.

### `cancel_leave`

| Field | Type | Meaning |
|---|---|---|
| `leaveId` | `string` | e.g. `L9000001` (see `get_leave_status`) |
| `confirm` | `boolean?` | **Unset on the first call.** `true` + a token to actually withdraw |
| `previewToken` | `string?` | From the preview. Required with `confirm: true` |

Two-step like `apply_leave`: preview reports the leave's current record —
type, dates, approval status exactly as VTOP prints it — plus whether VTOP
publishes a withdraw control for it, and mints a single-use token bound to
that leave id and caller. Confirming posts the row's own withdraw target
(read at runtime, never guessed); script-call controls and missing controls
fail loud instead of firing blind. The response is re-parsed and must read
as cancelled, else the result is `WITHDRAW UNCLEAR`. Declares
`readOnlyHint: false` so a compliant client prompts.

---

## Session

### `session_status`

Whether a session is active, as whom, whether credentials are configured, and —
importantly — whether **VTOP still honours the session**.

**Args:** none

Call this before assuming you need to log in. A session that died server-side is
caught here rather than on your next real question.

### `get_captcha`

Fetches VTOP's login captcha and returns the image, upscaled 5× so it stays
legible. **Read it, then call `login` immediately** — it expires in well under a
minute.

**Args:** none

If the read is ever missed, ask for a fresh captcha and type the characters
yourself. That's faster and more reliable than a re-read.

### `login`

| Field | Type | Meaning |
|---|---|---|
| `captcha` | `string` | From `get_captcha` |
| `username` | `string?` | Omit if `VTOP_USERNAME` is set |
| `password` | `string?` | Omit if `VTOP_PASSWORD` is set |

If login replies that credentials are missing, ask the user for them and call
again with them.

### `logout`

Signs out and clears the session.

**Args:** none

---

## Notes on session behaviour

**VTOP idles a session out after ~20 minutes** of inactivity — an idle timeout,
not a fixed lifetime from login. The server therefore touches it every 5 minutes
by default (`VTOP_KEEPALIVE_MINUTES`), so an open session stays usable
indefinitely.

**VTOP sometimes serves a Google reCAPTCHA** instead of the text captcha. The
server reloads the login page a few times until the text captcha appears. If it
persists, wait — repeated attempts escalate VTOP's risk scoring toward an
account lockout.

---

## Related

- [errors.md](errors.md) — error codes and what to do about them
- [development.md](development.md) — how these are implemented and tested
