# How VTOP behaves on Bhopal

VTOP's markup is idiosyncratic, and most of this was learned the hard way. If
you extend this server or debug a parser, this is the page to read first.

Everything here is covered by offline fixtures in `scripts/fixtures.ts` and
`scripts/*-test.ts`. **Those fixtures use synthetic data only** — see
[CONTRIBUTING.md](../CONTRIBUTING.md).

---

## Endpoints

| Area | Path | Notes |
|---|---|---|
| Base | `https://vtop.vitbhopal.ac.in/vtop` | Override with `VTOP_BASE_URL` |
| Semester list | `StudentTimeTable` | The Chennai-era `StudentTimeTableChn` path returns "not available" |
| Leave | `hostels/student/leave/1..4` | **One path family driven by a `control` parameter**, not separate routes |
| Leave withdraw | `hostels/student/leave/5` via `requestDataListUpdate` Cancel button | The status row's button carries `data-controlname="cancelButton"`, `data-urltext`, `data-parameters="['leaveId']"`, `data-rownumber` — the TABLE branch POSTs `_csrf` + `authorizedID` + `cancelButton` + `form` + `control` + row id + `x`. Missing ids concat to the literal `undefined`, like the page |
| Leave history | `hostels/student/barcodeleave` | Full history; standard `verifyMenu` handshake, NO `leave/1` priming |
| Profile (all sections) | `studentsRecord/StudentProfileAllView` | Personal/educational/family/proctor/hostel in one response |
| Acknowledgments | `admissions/AcknowledgmentView` | Document checklist |
| Proctor | `proctor/viewProctorDetails` | Same table as the profile proctor section |
| Curriculum | `academics/common/Curriculum` | Per-category course tables; completed rows carry `bg-success` |
| Fee receipts | `finance/getStudentReceipts` + `finance/dupReceiptNewP2P` | List, then one receipt's detail HTML. Detail ref is `<no>/8/BPL` plus the list page's `applno`/`regno` hidden fields |
| Calendar | `academics/common/CalendarPreview` → `getListForSemester` | Semester select fires `getDateForSemesterPreview` (`semSubId`); group select fires `getListForSemester` (`semSubId` + `classGroupId`, 9 groups, `COMB` default) |
| Faculty search | `hrms/employeeSearchForStudent` → `hrms/EmployeeSearchForStudent` → `hrms/EmployeeSearch1ForStudent` | Search posts the name fragment as **`empId`** (not the box name `searchEmployee`); detail re-sends the row's employee id (numeric or alphanumeric) as `empId`. All three take the standard auth fields |
| Syllabus PDF | `GET courseSyllabusDownload1/{CODE}` | Auth fields as query params (the `vtopDownload()` URL). Answers `application/pdf`; failures arrive as HTTP 200 HTML |
| Profile photo | `GET users/image/?id={regNo}` | The avatar on every logged-in page. Answers image bytes (observed JPEG bytes served as `image/png` — sniff the magic, not the header) |

### The leave endpoints, specifically

`leave/1` is the page shell, `leave/2` the form, `leave/3` the submit, `leave/4`
the status. They are **not** independently reachable — the form and status
requests only work once the shell has been loaded in the same session.

The submit payload is `_csrf` + the form fields + `authorizedID` + `form` +
`control` + `x`.

**There is no `verifyMenu` step.** That absence is why roughly fifty guessed
paths under `hostel/*` all returned *"This menu is not available at present!!!"*
— VTOP was answering correctly about paths that simply don't exist.

---

## Markup quirks

**Attendance — the header row has no `<th>`.** A positional parser hangs on it.
Rows are matched by content instead. The cells are combined "Course Detail" /
"Class Detail" strings rather than separate code/title/slot columns.

**Exam schedule — an extra row above the header.** A "General (Semester)" row
sits *before* the real header row, so `table > tr:first-child` is not the header.

**Semester grades — Credits split into L / P / J / C**, plus Grading Type and
Grand Total columns, rather than a single Credits column.

**Grade history — course codes look exactly like month names.** `ENG1004` is a
course, not April. The parser has to tell them apart. `P` (pass) grades are
excluded from GPA — including them silently inflates it.

**Profile — the profile page has no branch.** It only carries the Class 12
stream, so branch is read from the grade-history header instead.

**Calendar — every student group is listed per day.** Only the "General" entry
is used. Saturdays marked **"Activities Friday"** follow Friday's timetable, and
a working Saturday can override the weekday entirely.

**Timetable — the grid returns empty day/time cells.** Each course cell carries a
nested `sessions` array, which is merged in so day and times get populated.

**Faculty search — the box name is not the field name.** The input's id/name
is `searchEmployee`, but the page posts `empId`. The results table's header
row reads "Name of the Faculty / Designation / School / Centre / Action";
the Action button's id and `getEmployeeIdNo("…")` onclick carry the employee
id. The detail card is a bordered label/value table; a literal `null` cabin
means unpublished. Mobile/intercom rows are commented out server-side for
most records — their absence is normal.

**Syllabus — a PDF behind a GET.** Same auth-fields-as-query pattern as the
page's `vtopDownload()`. Always check the `%PDF` header: a missing syllabus
comes back as HTTP 200 HTML.

**Attendance marks vary by semester.** Binary at 75%+ in the current term,
banded (95+ / 90+ / <75%) in earlier ones. The rule is inferred per semester
from published data and reported as `unknown` when it can't be determined —
never assumed.

---

## Failure pages arrive as HTTP 200

This is the single most dangerous class of bug on this page, because the
failure is **invisible**:

| What VTOP sends | Status | What it would have parsed as |
|---|---|---|
| "This menu is not available at present!!!" | **200** | empty result |
| "Unable to process your request" | **200** | empty result |
| An empty `<table>` | **200** | "you have no records" |

All three now raise a distinct error instead. When writing a new parser, check
the body for these markers before trusting an empty result.

The same trap applies to login: VTOP serves some pages as 404 when a session is
dead, and 404 for paths that genuinely don't exist. See
`ENDPOINT_NOT_FOUND` in [errors.md](errors.md).

---

## Things VTOP does not expose

- **No grade or GPA inputs.** VIT grades relatively — against a class average
  and spread — and VTOP publishes neither. There is therefore no honest way to
  predict a letter grade, which is why no tool tries.
- **No leave duration limits.** Not in the form markup, not in the dropdown
  response. `get_leave_type_rules` probes all nine types and VTOP answers with
  nothing. Only `HT1 ≤ 14` is known, from an actual rejection.
- **No OD approval flags.** VTOP does not mark which OD days were DSW-approved,
  so nothing in this server can separate them, which is why there is no OD-counting tool.
- **No internal-marks total row.** The scale differs per course, so a percentage
  computed against the published components is a lower bound, not a real figure.

---

## Adding a parser

1. **Never guess a path.** Look at a real request in your browser's DevTools
   network tab. Guessing produced fifty dead ends here.
2. **Check for failure markers first.** A 200 is not a success.
3. **Prefer content matching over positional parsing.** Bhopal's missing `<th>`
   headers make positions unreliable.
4. **Preserve a real semester id or course code in the fixture.** They name a
   term or a catalogue entry, not a person, and a fake-looking one would not
   test the parser.
5. **Never put a real value in a fixture.** See [CONTRIBUTING.md](../CONTRIBUTING.md).
6. **Add the new shape to `test:privacy`'s synthetic allowlist** if you introduce
   new fake identifiers, so the guard stays strict for everything else.

---

## Related

- [tools.md](tools.md) — what each tool returns
- [development.md](development.md) — tests and architecture
