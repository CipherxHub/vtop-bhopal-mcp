# Hostel leave

`apply_leave` is the only tool in this server that **writes to VTOP**. It
creates a real application your hostel proctor has to action, so it is
deliberately hard to trigger by accident.

---

## The two-step design

### Call 1 — preview

Pass the details with `confirm` unset. **Nothing is sent to VTOP.** You get
back:

- the **normalised** values, so what you read is exactly what would be submitted
- every validation rule that fired, and any warnings
- a **`previewToken`** — a fingerprint over every submitted field
- what the leave would **cost you**: classes it clashes with, and exams

```
{ "leaveCode": "OG1", "visitingPlace": "Sehore",
  "leaveFromDate": "2026-10-20", "fromTime": "9:00 AM",
  "leaveToDate": "2026-10-20", "toTime": "6:00 PM",
  "reason": "Family function in Sehore." }
```

### Call 2 — submit

Repeat the **identical** fields, plus `confirm: true` and the `previewToken`.

The token is an FNV-1a fingerprint over every field. Change anything between the
two calls — a different time, a typo fix, an added reason — and the token no
longer matches. The submission is **refused** and you must preview again.

That is the entire point: it stops "confirm" drifting onto a request you never
actually saw. The assistant cannot confirm a request that was never shown to you
in the form that would be sent.

---

## Leave types

Read from VTOP's live dropdown by `get_leave_types`, not hard-coded. As of the
last check:

| Code | Type | Code | Type |
|---|---|---|---|
| `SO` | Special Outing | `WV` | Winter Vacation |
| `WP` | With Parent Leave | `HT1` | Home Town |
| `EP` | Official Leaves | `LG1` | Local Guardian |
| `SV` | Summer Vacation | `EY1` | Emergency Leave |
| | | `OG1` | **Day Outing** |

If VTOP adds or retires a type, `get_leave_types` reflects it immediately. Never
hard-code this list.

---

## Rules enforced before anything is sent

**Day Outing (`OG1`) must return by 18:00, inclusive.** 18:00 passes; 18:01 is
refused. The deadline applies to that type **only** — other types are allowed
later but raise a warning, because a proctor may still query it.

**Times are normalised before validation**, so `6:00 PM`, `1800`, `18:00` and
`6.00 pm` are all accepted and all reduce to the same value. The preview and the
submission therefore always see identical values — which is what makes the
fingerprint meaningful.

**Dates** must be ISO `YYYY-MM-DD` and not in the past. Return cannot precede
departure.

**Visiting place** is required and capped at VTOP's 150 characters.

**Reason** is required.

---

## What the preview tells you it would cost

**Classes.** From your timetable and the academic calendar. Holidays, exam days
and Saturdays that follow another weekday's timetable are all accounted for, so
a "5 classes missed" figure means five actual classes.

**Exams.** Compared against the **hours you are away**, not just the date:

- leave starting **17:00** does not cost you a **13:15–16:15** paper
- leave starting **08:00** does

An exam with no published time is reported as **`UNKNOWN`**, never assumed clear.

> **An exam clash is a warning, not a block.** Submission is still allowed.
> Sometimes a clash is unavoidable, and whether to take the leave anyway is your
> decision, not this tool's. Make sure you actually read the warning.

---

## Duration limits — what is and isn't known

VTOP enforces a maximum length per leave type **server-side** and publishes
**none** of them. Not in the form markup. Not in the dropdown's response.
`get_leave_type_rules` probes all nine types specifically to find out, and VTOP
answers with nothing.

The only cap confirmed is **Home Town (`HT1`) ≤ 14 days**, found by having an
over-long application rejected. That one is checked locally so you get a clear
error instead of a server-side rejection.

The other eight are deliberately **not** guessed. A wrong cap would block
applications VTOP would have accepted — the tool would refuse something perfectly
valid, and there is no way for you to override it. Unknown stays unknown.

If VTOP rejects a request, **nothing is created**. No half-submitted application,
no orphaned record. You can apply under a different type.

`LEAVE_MAX_DAYS` in `src/services/constants.ts` is a `Partial` record — absent
means *unknown*, not *unlimited*.

---

## Status

`get_leave_status` returns your applications with:

- leave id and type
- dates, times and duration
- approval status — `REQUEST RAISED`, `PROCTOR APPROVAL PENDING`, `APPROVED`,
  `REJECTED`, or whatever VTOP currently uses
- approver remarks, including the staff id when VTOP prints one
- gate-pass OUT/IN flags

**`PROCTOR APPROVAL PENDING` is not approval.** It means the request was raised
and nobody has actioned it yet. Gate-pass flags populate around actual departure,
not at application time, so `null` there is normal.

Statuses are read from VTOP verbatim. An unrecognised status is passed through
rather than mapped to a guess.

---

## Privacy note

Approver remarks sometimes contain a **proctor's staff id**. That is third-party
data. If you paste a `get_leave_status` result into an issue, redact it.

---

## Related

- [tools.md](tools.md) — `apply_leave` and the other leave tools
- [errors.md](errors.md) — what to do when a submission is refused
