#!/usr/bin/env tsx
/**
 * Offline tests for the hostel leave rules.
 *   npm run test:leave
 *
 * The load-bearing case is the 6 PM DAY OUTING rule: it applies to DAY OUTING
 * only, and 18:00 itself must pass. Everything else here is about not letting
 * a malformed request reach a proctor who then has to process a withdrawal.
 */
import assert from "node:assert/strict";
import {
  DAY_OUTING_LATEST_RETURN,
  LEAVE_MAX_DAYS,
  LEAVE_TYPES,
} from "../src/services/constants.js";
import {
  VISITING_PLACE_MAX,
  durationDaysInclusive,
  examClockToMinutes,
  findClassOverlaps,
  findExamOverlaps,
  issueCancelToken,
  issuePreviewToken,
  leaveFingerprint,
  minutesOfDay,
  normaliseExamDate,
  normaliseTime,
  validateLeave,
  verifyCancelToken,
  verifyPreviewToken,
  type LeaveRequest,
} from "../src/services/leave.js";

let passed = 0;
const PREVIEW_OWNER = "test-owner-a";
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    throw err;
  }
}

const TODAY = "2026-10-13";
const KNOWN = LEAVE_TYPES.map((t) => t.code);

const req = (over: Partial<LeaveRequest> = {}): LeaveRequest => ({
  leaveCode: "OG1",
  visitingPlace: "Bhopal",
  leaveFromDate: "2026-10-20",
  fromTime: "09:00",
  leaveToDate: "2026-10-20",
  toTime: "18:00",
  reason: "Family function in Bhopal for two days.",
  ...over,
});
const check1 = (over: Partial<LeaveRequest> = {}) =>
  validateLeave(req(over), { todayISO: TODAY, knownTypes: KNOWN });
const errs = (v: ReturnType<typeof validateLeave>) =>
  v.issues.filter((i) => i.severity === "error");
const warns = (v: ReturnType<typeof validateLeave>) =>
  v.issues.filter((i) => i.severity === "warning");

console.log("leave rules (offline)");

// --- the 6 PM DAY OUTING rule ---------------------------------------------
check("DAY OUTING returning at exactly 18:00 is allowed", () => {
  const v = check1({ toTime: "18:00" });
  assert.equal(v.valid, true, "18:00 is the inclusive deadline");
  assert.equal(v.blockedByDayOutingRule, false);
});

check("DAY OUTING returning at 18:01 is rejected", () => {
  const v = check1({ toTime: "18:01" });
  assert.equal(v.valid, false);
  assert.equal(v.blockedByDayOutingRule, true);
  assert.match(errs(v).map((i) => i.message).join(" "), /must be back by 18:00/);
});

check("the boundary constant matches the rule the student gave", () => {
  assert.equal(DAY_OUTING_LATEST_RETURN, "18:00");
  const latest = minutesOfDay(DAY_OUTING_LATEST_RETURN)!;
  assert.equal(latest, 18 * 60);
  assert.ok(minutesOfDay("18:01")! > latest);
  assert.ok(minutesOfDay("17:59")! < latest);
});

check("the 6 PM rule does NOT apply to other leave types", () => {
  // Their history has a SPECIAL OUTING approved at 18:30, so this must warn
  // rather than block. Getting this wrong would refuse a legitimate request.
  const v = check1({ leaveCode: "SO", toTime: "18:30" });
  assert.equal(v.valid, true, "must not block");
  assert.equal(v.blockedByDayOutingRule, false);
  assert.match(warns(v).map((i) => i.message).join(" "), /applies to DAY OUTING only/);
});

check("every leave type except OG1 is exempt from the 6 PM rule", () => {
  for (const { code } of LEAVE_TYPES) {
    const v = check1({ leaveCode: code, toTime: "21:00" });
    if (code === "OG1") {
      assert.equal(v.valid, false, `${code} must block`);
    } else {
      assert.equal(v.valid, true, `${code} must not block`);
    }
  }
});

check("the published leave codes match VTOP's dropdown", () => {
  assert.deepEqual(
    LEAVE_TYPES.map((t) => `${t.code}=${t.label}`),
    [
      "SO=SPECIAL OUTING",
      "WP=WITH PARENT LEAVE",
      "EP=OFFICIAL LEAVES (GATE / CAMPUS INTERVIEW)",
      "SV=SUMMER VACATION",
      "WV=WINTER VACATION",
      "HT1=HOME TOWN",
      "LG1=LOCAL GUARDIAN",
      "EY1=EMERGENCY LEAVE",
      "OG1=DAY OUTING",
    ],
  );
});

// --- required fields -------------------------------------------------------
check("an unknown leave code is rejected", () => {
  const v = check1({ leaveCode: "ZZ" });
  assert.equal(v.valid, false);
  assert.match(errs(v).map((i) => i.message).join(" "), /not a leave type VTOP offers/);
});

check("visiting place is required and length-capped like VTOP", () => {
  assert.equal(check1({ visitingPlace: "   " }).valid, false);
  const atLimit = "a".repeat(VISITING_PLACE_MAX);
  assert.equal(check1({ visitingPlace: atLimit }).valid, true, "150 chars is allowed");
  assert.equal(check1({ visitingPlace: "a".repeat(VISITING_PLACE_MAX + 1) }).valid, false);
});

check("reason is required, and a stub reason only warns", () => {
  assert.equal(check1({ reason: "" }).valid, false, "empty reason is an error");
  const stub = check1({ reason: "trip" });
  assert.equal(stub.valid, true, "a short reason is not fatal");
  assert.equal(warns(stub).length, 1);
});

// --- dates and times -------------------------------------------------------
check("a past from-date is rejected", () => {
  const v = check1({ leaveFromDate: "2026-10-12", leaveToDate: "2026-10-12" });
  assert.equal(v.valid, false);
  assert.match(errs(v).map((i) => i.message).join(" "), /in the past/);
});

check("today itself is allowed", () => {
  assert.equal(check1({ leaveFromDate: TODAY, leaveToDate: TODAY }).valid, true);
});

check("to-date before from-date is rejected", () => {
  const v = check1({ leaveFromDate: "2026-10-20", leaveToDate: "2026-10-19" });
  assert.equal(v.valid, false);
  assert.match(errs(v).map((i) => i.message).join(" "), /is before From date/);
});

check("returning before departing on one day is rejected", () => {
  const v = check1({ fromTime: "18:00", toTime: "17:00" });
  assert.equal(v.valid, false);
  assert.match(errs(v).map((i) => i.message).join(" "), /is before Time From/);
});

check("identical from and to times are rejected as a zero-length leave", () => {
  const v = check1({ fromTime: "10:00", toTime: "10:00" });
  assert.equal(v.valid, false);
  assert.match(errs(v).map((i) => i.message).join(" "), /same instant/);
});

check("a time inverted across days is fine, because dates decide", () => {
  // 20 Oct 18:00 -> 22 Oct 09:00 looks inverted but spans days.
  const v = check1({ fromTime: "18:00", toTime: "09:00", leaveToDate: "2026-10-22" });
  assert.equal(v.valid, true);
  assert.equal(v.durationDays, 3);
});

check("malformed dates and times are rejected with the expected shape", () => {
  const v = check1({
    leaveFromDate: "20-10-2026",
    leaveToDate: "22/10/2026",
    fromTime: "9am",
    toTime: "25:00",
  });
  assert.equal(v.valid, false);
  const flagged = errs(v).map((i) => i.field).sort();
  assert.deepEqual(flagged, ["fromTime", "leaveFromDate", "leaveToDate", "toTime"]);
  const msg = errs(v).map((i) => i.message).join(" ");
  assert.match(msg, /must be YYYY-MM-DD/);
  assert.match(msg, /must be HH:MM 24-hour/);
});

check("duration counts both ends inclusively", () => {
  assert.equal(durationDaysInclusive("2026-10-20", "2026-10-20"), 1);
  assert.equal(durationDaysInclusive("2026-10-20", "2026-10-22"), 3);
  assert.equal(durationDaysInclusive("2026-10-20", "2026-10-01"), null, "invalid order");
});

// --- time input tolerance --------------------------------------------------
check("times are normalised from what a student would actually type", () => {
  assert.equal(normaliseTime("18:00"), "18:00");
  assert.equal(normaliseTime("6:00 PM"), "18:00");
  assert.equal(normaliseTime("6pm"), "18:00");
  assert.equal(normaliseTime("6:05pm"), "18:05");
  assert.equal(normaliseTime("12:00 AM"), "00:00");
  assert.equal(normaliseTime("12pm"), "12:00");
  assert.equal(normaliseTime("1800"), "18:00");
  assert.equal(normaliseTime("8.30"), "08:30");
  assert.equal(normaliseTime("25:00"), null);
  assert.equal(normaliseTime("13pm"), null, "13pm is not a real time");
  assert.equal(normaliseTime(""), null);
});

check("minutesOfDay only accepts a real 24-hour clock", () => {
  assert.equal(minutesOfDay("00:00"), 0);
  assert.equal(minutesOfDay("23:59"), 1439);
  assert.equal(minutesOfDay("24:00"), null);
  assert.equal(minutesOfDay("7:5"), null, "minutes must be two digits");
  assert.equal(minutesOfDay("7pm"), null);
});

// --- confirmation fingerprint ----------------------------------------------
check("the fingerprint is stable for the same request", () => {
  assert.equal(leaveFingerprint(req()), leaveFingerprint(req()));
});

check("the fingerprint ignores surrounding whitespace", () => {
  assert.equal(
    leaveFingerprint(req({ visitingPlace: "  Bhopal  " })),
    leaveFingerprint(req({ visitingPlace: "Bhopal" })),
  );
});

check("changing ANY field invalidates the fingerprint", () => {
  const base = leaveFingerprint(req());
  const mutations: Partial<LeaveRequest>[] = [
    { leaveCode: "SO" },
    { visitingPlace: "Indore" },
    { leaveFromDate: "2026-10-21" },
    { fromTime: "10:00" },
    { leaveToDate: "2026-10-21" },
    { toTime: "17:00" },
    { reason: "Something else entirely." },
  ];
  for (const m of mutations) {
    assert.notEqual(
      leaveFingerprint(req(m)),
      base,
      `changing ${Object.keys(m)[0]} must change the fingerprint`,
    );
  }
});

check("the fingerprint is case-insensitive only for the leave code", () => {
  assert.equal(leaveFingerprint(req({ leaveCode: "og1" })), leaveFingerprint(req()));
});

// --- server-signed preview tokens (issue #6) -------------------------------
check("an issued preview token verifies for the identical request", () => {
  const r = req();
  const tok = issuePreviewToken(r, PREVIEW_OWNER);
  assert.match(tok, /^[0-9a-f]{32}\.\d+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(verifyPreviewToken(r, tok, PREVIEW_OWNER), { ok: true });
});

check("a preview token is single-use", () => {
  const r = req();
  const tok = issuePreviewToken(r, PREVIEW_OWNER);
  assert.deepEqual(verifyPreviewToken(r, tok, PREVIEW_OWNER), { ok: true });
  const second = verifyPreviewToken(r, tok, PREVIEW_OWNER);
  assert.equal(second.ok, false);
  assert.match((second as { reason: string }).reason, /already used/);
});

check("a preview token does not verify for changed fields", () => {
  const tok = issuePreviewToken(req(), PREVIEW_OWNER);
  const altered = verifyPreviewToken(req({ toTime: "17:00" }), tok, PREVIEW_OWNER);
  assert.equal(altered.ok, false);
  assert.match((altered as { reason: string }).reason, /does not match/);
});

check("a forged preview token is rejected", () => {
  const r = req();
  assert.equal(verifyPreviewToken(r, "forged", PREVIEW_OWNER).ok, false);
  assert.equal(verifyPreviewToken(r, leaveFingerprint(r), PREVIEW_OWNER).ok, false);
});

// --- server-signed cancel tokens -------------------------------------------
check("an issued cancel token verifies for its leave id only", () => {
  // Fresh token per assertion: verifies are single-use.
  assert.deepEqual(verifyCancelToken("L9000001", issueCancelToken("L9000001", PREVIEW_OWNER), PREVIEW_OWNER), { ok: true });
  assert.deepEqual(verifyCancelToken("l9000001", issueCancelToken("L9000001", PREVIEW_OWNER), PREVIEW_OWNER), { ok: true }, "ids match case-insensitively");
  assert.equal(verifyCancelToken("L9000002", issueCancelToken("L9000001", PREVIEW_OWNER), PREVIEW_OWNER).ok, false, "another id must not verify");
  assert.equal(verifyCancelToken("L9000001", issueCancelToken("L9000001", PREVIEW_OWNER), "test-owner-b").ok, false, "another caller must not verify");
});

check("an apply token never verifies as a cancel token", () => {
  // Domain separation: same caller, same process, different handshake.
  const tok = issuePreviewToken(req(), PREVIEW_OWNER);
  assert.equal(verifyCancelToken("L9000001", tok, PREVIEW_OWNER).ok, false);
});

// --- class overlap ---------------------------------------------------------
const CLASSES = [
  { date: "2026-10-20", courseCode: "ABC105", courseName: "Course E", startTime: "08:30", endTime: "10:00", venue: "AB-318" },
  { date: "2026-10-20", courseCode: "ABC102", courseName: "Course B", startTime: "11:40", endTime: "13:10", venue: "AB-126" },
  { date: "2026-10-21", courseCode: "ABC101", courseName: "Course A", startTime: "08:30", endTime: "10:00", venue: "AB02-409" },
];

check("a same-day leave swallows every class that day", () => {
  const r = findClassOverlaps(
    { fromDate: "2026-10-20", fromTime: "08:00", toDate: "2026-10-20", toTime: "18:00" },
    CLASSES,
  );
  assert.equal(r.missed.length, 2, "both of the 20th's classes");
  assert.equal(r.affectedDays, 1);
  assert.deepEqual(r.byCourse[0], {
    courseCode: "ABC105",
    courseName: "Course E",
    missed: 1,
  });
});

check("an early departure only misses the later classes", () => {
  const r = findClassOverlaps(
    { fromDate: "2026-10-20", fromTime: "10:30", toDate: "2026-10-20", toTime: "18:00" },
    CLASSES,
  );
  assert.equal(r.missed.length, 1, "the 08:30 class is already over");
  assert.equal(r.missed[0].courseCode, "ABC102");
  assert.deepEqual(r.partialDays, ["2026-10-20"], "morning class survives the day");
});

check("an early return leaves a late class untouched", () => {
  const r = findClassOverlaps(
    { fromDate: "2026-10-20", fromTime: "08:00", toDate: "2026-10-20", toTime: "10:30" },
    CLASSES,
  );
  assert.equal(r.missed.length, 1, "only the 08:30 class falls inside");
  assert.equal(r.missed[0].courseCode, "ABC105");
});

check("a multi-day leave misses every class on every covered day", () => {
  const r = findClassOverlaps(
    { fromDate: "2026-10-20", fromTime: "08:00", toDate: "2026-10-21", toTime: "18:00" },
    CLASSES,
  );
  assert.equal(r.missed.length, 3);
  assert.equal(r.affectedDays, 2);
  assert.equal(r.byCourse.length, 3);
  assert.equal(r.byCourse.reduce((s, c) => s + c.missed, 0), 3);
});

check("a multi-day leave keeps boundary filtering on first and last days", () => {
  // Departs 2026-10-20 17:00, returns 2026-10-22 10:00. Morning class on the
  // 20th ends before departure so it is not missed; interior 21st is missed.
  const r = findClassOverlaps(
    { fromDate: "2026-10-20", fromTime: "17:00", toDate: "2026-10-22", toTime: "10:00" },
    [
      ...CLASSES,
      { date: "2026-10-22", courseCode: "ABC101", courseName: "Course A", startTime: "11:40", endTime: "13:10", venue: "AB02-409" },
    ],
  );
  assert.ok(!r.missed.some((m) => m.date === "2026-10-20"), "20th morning classes survive a 17:00 departure");
  assert.ok(r.missed.some((m) => m.date === "2026-10-21"), "interior day is fully missed");
  assert.ok(!r.missed.some((m) => m.date === "2026-10-22"), "11:40 class after a 10:00 return is not missed");
  assert.ok(r.partialDays.includes("2026-10-20"), "20th reported as partial");
});

check("partialDays does not depend on session order", () => {
  // One missed class + one outside-window class on the same day: both orders
  // must report the partial day. Regression guard — the old code only marked
  // partial when no miss had been recorded yet for the date.
  const leave = { fromDate: "2026-11-03", fromTime: "12:00", toDate: "2026-11-03", toTime: "18:00" };
  const late = { date: "2026-11-03", courseCode: "ABC101", courseName: "A", startTime: "14:00", endTime: "15:00", venue: "X" };
  const early = { date: "2026-11-03", courseCode: "ABC102", courseName: "B", startTime: "09:00", endTime: "10:00", venue: "Y" };
  for (const sessions of [[late, early], [early, late]]) {
    const r = findClassOverlaps(leave, sessions);
    assert.equal(r.missed.length, 1);
    assert.deepEqual(r.partialDays, ["2026-11-03"], `order ${sessions[0].courseCode}-first`);
  }
});

check("classes outside the window are never counted", () => {
  const r = findClassOverlaps(
    { fromDate: "2026-10-22", fromTime: "08:00", toDate: "2026-10-22", toTime: "18:00" },
    CLASSES,
  );
  assert.equal(r.missed.length, 0);
  assert.equal(r.affectedDays, 0);
  assert.deepEqual(r.byCourse, []);
});

check("an empty timetable yields an empty overlap, not a crash", () => {
  const r = findClassOverlaps(
    { fromDate: "2026-10-20", fromTime: "08:00", toDate: "2026-10-20", toTime: "18:00" },
    [],
  );
  assert.equal(r.missed.length, 0);
  assert.equal(r.affectedDays, 0);
});

// --- duration caps ---------------------------------------------------------
// Only HT1's cap is known, because it is the only one VTOP has been observed
// enforcing. Everything else must stay un-enforced rather than guessed.
check("HOME TOWN over 14 days is refused locally, as VTOP would", () => {
  const v = check1({
    leaveCode: "HT1",
    leaveFromDate: "2026-10-30",
    leaveToDate: "2026-11-15", // 17 days
  });
  assert.equal(v.valid, false);
  assert.match(errs(v).map((i) => i.message).join(" "), /may not exceed 14 days/);
  assert.equal(v.durationDays, 17);
});

check("HOME TOWN at exactly 14 days is allowed", () => {
  // 30 Oct -> 12 Nov inclusive is exactly 14.
  const v = check1({ leaveCode: "HT1", leaveFromDate: "2026-10-30", leaveToDate: "2026-11-12" });
  assert.equal(v.valid, true, "the cap is inclusive");
  assert.equal(v.durationDays, 14);
});

check("WINTER VACATION is NOT capped locally, because its cap is unknown", () => {
  // WV accepted 17 days for real (observed live). Refusing it here would
  // block an application VTOP accepts.
  const v = check1({
    leaveCode: "WV",
    leaveFromDate: "2026-10-30",
    leaveToDate: "2026-11-15",
  });
  assert.equal(v.valid, true, "no local cap for WV");
  assert.equal(errs(v).length, 0);
});

check("a long leave on an unknown type warns without blocking", () => {
  const v = check1({
    leaveCode: "SO",
    leaveFromDate: "2026-10-30",
    leaveToDate: "2026-11-15",
  });
  assert.equal(v.valid, true, "must not block");
  assert.match(warns(v).map((i) => i.message).join(" "), /No maximum is known/);
});

check("a short leave on an unknown type stays quiet", () => {
  const v = check1({ leaveCode: "SO", leaveFromDate: "2026-10-20", leaveToDate: "2026-10-20" });
  assert.equal(v.valid, true);
  assert.deepEqual(warns(v), [], "no spurious warning on a 1-day leave");
});

check("no cap is invented for any type other than HT1", () => {
  assert.deepEqual(Object.keys(LEAVE_MAX_DAYS), ["HT1"], "only HT1 has a known cap");
});

// --- exam overlap ----------------------------------------------------------
// Fixtures are the student's REAL exam schedule (BL20262701), all session AN1,
// 01:15 PM - 04:15 PM. The Diwali leave (30 Oct 17:00 -> 15 Nov 21:00) is the
// case that motivated this check.
const REAL_EXAMS = [
  { examType: "FAT", courseCode: "ABC101", courseName: "Course A", examDate: "16-OCT-2026", time: "01:15 PM - 04:15 PM" },
  { examType: "FAT", courseCode: "ABC102", courseName: "Course B", examDate: "18-OCT-2026", time: "01:15 PM - 04:15 PM" },
  { examType: "FAT", courseCode: "ABC103", courseName: "Course C", examDate: "22-OCT-2026", time: "01:15 PM - 04:15 PM" },
  { examType: "FAT", courseCode: "ABC104", courseName: "Course D", examDate: "25-OCT-2026", time: "01:15 PM - 04:15 PM" },
  { examType: "FAT", courseCode: "ABC105", courseName: "Course E", examDate: "30-OCT-2026", time: "01:15 PM - 04:15 PM" },
];

check("exam dates and printed clock times parse", () => {
  assert.equal(normaliseExamDate("30-OCT-2026"), "2026-10-30");
  assert.equal(normaliseExamDate("16-OCT-2026"), "2026-10-16");
  assert.equal(normaliseExamDate(""), null);
  assert.equal(normaliseExamDate("no date"), null);
  assert.equal(examClockToMinutes("01:15 PM"), 13 * 60 + 15);
  assert.equal(examClockToMinutes("04:15 PM"), 16 * 60 + 15);
  assert.equal(examClockToMinutes("12:00 AM"), 0);
  assert.equal(examClockToMinutes("12:00 PM"), 720);
});

check("THE Diwali case: 5 PM departure clears the 30 Oct FAT", () => {
  // 30 Oct 17:00 -> 15 Nov 21:00. ABC105's FAT is 13:15-16:15 that day.
  const r = findExamOverlaps(
    { fromDate: "2026-10-30", fromTime: "17:00", toDate: "2026-11-15", toTime: "21:00" },
    REAL_EXAMS,
  );
  assert.equal(r.conflicts.length, 0, "must NOT flag a clash when there is none");
  const c = r.cleared.find((x) => x.exam.courseCode === "ABC105");
  assert.ok(c, "the FAT should still be reported, as clear");
  assert.equal(c.gapMinutes, 45, "13:15-16:15 then 17:00 is 45 minutes");
  assert.match(c.explanation, /clear by 45 minutes/);
  assert.equal(r.checked.length, 1, "only the 30th has an exam inside the window");
});

check("an 9 AM departure the same day IS a conflict", () => {
  // The version that was caught by hand. This is what the tool failed to see.
  const r = findExamOverlaps(
    { fromDate: "2026-10-30", fromTime: "09:00", toDate: "2026-11-15", toTime: "21:00" },
    REAL_EXAMS,
  );
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].exam.courseCode, "ABC105");
  assert.match(r.conflicts[0].explanation, /would miss it/);
  assert.match(r.conflicts[0].explanation, /no re-test/);
});

check("a same-day leave covering the exam hours is a conflict", () => {
  const r = findExamOverlaps(
    { fromDate: "2026-10-30", fromTime: "12:00", toDate: "2026-10-30", toTime: "18:00" },
    REAL_EXAMS,
  );
  assert.equal(r.conflicts.length, 1);
});

check("an exam on an interior day of a multi-day leave is a conflict", () => {
  const r = findExamOverlaps(
    { fromDate: "2026-10-29", fromTime: "17:00", toDate: "2026-11-02", toTime: "09:00" },
    REAL_EXAMS,
  );
  assert.equal(r.conflicts.length, 1, "the 30th is interior to that window");
});

check("exams outside the window are not reported at all", () => {
  const r = findExamOverlaps(
    { fromDate: "2026-11-01", fromTime: "08:00", toDate: "2026-11-10", toTime: "18:00" },
    REAL_EXAMS,
  );
  assert.equal(r.checked.length, 0, "exam season ended on the 30th");
});

check("an exam with no published time is UNKNOWN, never assumed clear", () => {
  const r = findExamOverlaps(
    { fromDate: "2026-10-30", fromTime: "17:00", toDate: "2026-11-15", toTime: "21:00" },
    [{ examType: "FAT", courseCode: "ABC106", courseName: "Mystery", examDate: "05-NOV-2026", time: "" }],
  );
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.unknown.length, 1, "silence from VTOP is not permission to assume");
  assert.match(r.unknown[0].explanation, /published no time/);
});

check("exams with no published date are skipped entirely", () => {
  // CAT1/CAT2 rows come back with an empty date once they are done.
  const r = findExamOverlaps(
    { fromDate: "2026-10-30", fromTime: "17:00", toDate: "2026-11-15", toTime: "21:00" },
    [{ examType: "CAT1", courseCode: "ABC105", courseName: "X", examDate: "", time: "" }],
  );
  assert.equal(r.checked.length, 0);
});

check("an early return that ends before an exam leaves it clear", () => {
  const r = findExamOverlaps(
    { fromDate: "2026-10-30", fromTime: "08:00", toDate: "2026-10-30", toTime: "12:00" },
    REAL_EXAMS,
  );
  assert.equal(r.cleared.length, 1);
  assert.equal(r.cleared[0].gapMinutes, 75, "12:00 back, 13:15 exam");
});

// --- issue #9: confirm must reject a bad token before touching VTOP ----------
//
// The confirm path previously fetched the leave form, the current semester,
// the calendar, the timetable and the exam schedule, and minted a token, all
// BEFORE checking the caller's token. One cheap bogus-token call therefore cost
// several upstream VTOP requests. The early rejection is verified by source
// shape here and end-to-end by the http/tool suites; what is assertable
// offline is that verification is reachable without a client at all.

{
  const req: LeaveRequest = {
    leaveCode: "OG1",
    visitingPlace: "Sehore",
    leaveFromDate: "2026-10-20",
    fromTime: "9:00 AM",
    leaveToDate: "2026-10-20",
    toTime: "6:00 PM",
    reason: "Family function.",
  };

  check("confirm=true with no token is rejected, not silently previewed", () => {
    assert.equal(verifyPreviewToken(req, "", PREVIEW_OWNER).ok, false);
    assert.equal(verifyPreviewToken(req, "garbage", PREVIEW_OWNER).ok, false);
    assert.equal(verifyPreviewToken(req, "a.b.c", PREVIEW_OWNER).ok, false);
  });

  check("a token minted for one request cannot confirm a different one", () => {
    const tok = issuePreviewToken(req, PREVIEW_OWNER);
    assert.equal(verifyPreviewToken(req, tok, PREVIEW_OWNER).ok, true, "same fields verify");
    // Single-use: the nonce was consumed by the successful verify.
    assert.equal(verifyPreviewToken(req, tok, PREVIEW_OWNER).ok, false, "replay refused");
    const other = issuePreviewToken({ ...req, visitingPlace: "Bhopal" }, PREVIEW_OWNER);
    assert.equal(
      verifyPreviewToken(req, other, PREVIEW_OWNER).ok,
      false,
      "a token bound to different fields must not confirm",
    );
  });

  check("a preview token cannot be confirmed by another caller", () => {
    const tok = issuePreviewToken(req, PREVIEW_OWNER);
    assert.equal(verifyPreviewToken(req, tok, "test-owner-b").ok, false);
    assert.equal(verifyPreviewToken(req, tok, PREVIEW_OWNER).ok, true);
  });
}

console.log(`\n${passed} checks passed.`);
