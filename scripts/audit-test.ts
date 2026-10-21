#!/usr/bin/env tsx
/**
 * Offline tests for the attendance cross-check and the failed-course impact.
 *   npm run test:audit
 */
import assert from "node:assert/strict";
import { checkAttendanceTotals } from "../src/services/attendance-audit.js";
import { failedCourseImpacts } from "../src/services/cgpa-calc.js";
import type { CalendarDay, WeeklySchedule } from "../src/services/attendance-calc.js";
import type { AttendanceRecord } from "../src/types/index.js";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log("attendance audit + failed-course impact (offline)");

const record = (code: string, total: number | null, attended = 10): AttendanceRecord => ({
  courseCode: code,
  courseName: `Course ${code}`,
  courseType: "Theory",
  slot: "A1",
  attended,
  total,
  percentage: total ? (attended / total) * 100 : 0,
});

const day = (date: string, weekday: string): CalendarDay => ({
  date,
  instructional: true,
  dayOrderWeekday: null,
  label: "Working Day",
});

const schedule: WeeklySchedule = {
  SUN: [],
  MON: ["AAA101"],
  TUE: ["AAA101", "BBB202"],
  WED: [],
  THU: ["BBB202"],
  FRI: [],
  SAT: [],
};

check("expected sessions come from the timetable crossed with the calendar", () => {
  // Three Mondays, one Tuesday, one Thursday in the window.
  const calendar = [
    day("2026-10-05", "MON"),
    day("2026-10-06", "TUE"),
    day("2026-10-08", "THU"),
    day("2026-10-12", "MON"),
    day("2026-10-13", "TUE"),
    day("2026-10-19", "MON"),
  ];
  // VTOP's totals happen to agree here (5 and 3).
  const checks = checkAttendanceTotals([record("AAA101", 5), record("BBB202", 3)], schedule, calendar);
  const aaa = checks.find((c) => c.courseCode === "AAA101")!;
  const bbb = checks.find((c) => c.courseCode === "BBB202")!;
  assert.equal(aaa.expectedSessions, 5, "AAA101 meets on 3 Mondays + 2 Tuesdays");
  assert.equal(bbb.expectedSessions, 3, "BBB202 meets on 1 Tuesday + 1 Thursday + 1 Tuesday");
  assert.equal(aaa.matches, true);
  assert.equal(bbb.matches, true);
});

check("a difference against VTOP's total is reported, not hidden", () => {
  const calendar = [day("2026-10-05", "MON"), day("2026-10-12", "MON")];
  const checks = checkAttendanceTotals([record("AAA101", 5)], schedule, calendar);
  const aaa = checks.find((c) => c.courseCode === "AAA101")!;
  assert.equal(aaa.vtopTotal, 5);
  assert.equal(aaa.expectedSessions, 2);
  assert.equal(aaa.difference, -3, "VTOP counts 3 more than the calendar implies");
  assert.equal(aaa.matches, false);
  assert.match(aaa.note ?? "", /more session/);
});

check("a course with no published total is flagged, not compared", () => {
  const calendar = [day("2026-10-05", "MON")];
  const checks = checkAttendanceTotals([record("AAA101", null)], schedule, calendar);
  assert.equal(checks[0].difference, null);
  assert.equal(checks[0].matches, false);
  assert.match(checks[0].note ?? "", /no total/);
});

check("a working-Saturday day-order counts towards the right course", () => {
  // 2026-10-10 is a Saturday that runs the FRIDAY timetable; AAA101 meets
  // on Mondays, so a Friday day-order must NOT add an AAA101 session.
  const saturday: CalendarDay = {
    date: "2026-10-10",
    instructional: true,
    dayOrderWeekday: "FRI",
    label: "Remote Learning",
  };
  const calendar = [day("2026-10-05", "MON"), saturday];
  const checks = checkAttendanceTotals([record("AAA101", 1)], schedule, calendar);
  assert.equal(checks[0].expectedSessions, 1, "only the Monday counts");
});

check("a failed course shows what clearing it would buy", () => {
  // 100 graded credits at 8.0 (800 points), one 3-credit F.
  const state = { gradedCredits: 100, creditPoints: 800, cgpa: 8, creditsEarned: 97 };
  const impacts = failedCourseImpacts(
    state,
    [{ courseCode: "FFF101", courseName: "Failed One", credits: 3 }],
    100,
  );
  const f = impacts[0];
  assert.equal(f.currentPoints, 0);
  assert.equal(f.currentCgpa, 8);
  // Without the course: 800/97 = 8.247 -> 8.25.
  assert.equal(f.cgpaWithoutCourse, 8.25);
  // Re-registered and passed at D: (800 + 6*3)/103 = 818/103 = 7.94. The extra
  // credits in the denominator make it WORSE.
  assert.equal(f.cgpaIfRepassedAtD, 7.94);
  assert.equal(f.gainIfRepassed, -0.06);
  // Which grade would actually help: (800 + g*3)/103 > 8 -> g > 7.33 -> C (7)?
  // 800+21=821/103 = 7.97 (no); B (8): 824/103 = 8.0 (not >); A (9):
  // 827/103 = 8.03 > 8 -> A.
  assert.equal(f.passGradeThatHelps, "A");
});

check("a failed course with no credits does not break the maths", () => {
  const state = { gradedCredits: 100, creditPoints: 800, cgpa: 8, creditsEarned: 100 };
  const impacts = failedCourseImpacts(state, [{ courseCode: "X", courseName: "X", credits: 0 }], 100);
  assert.equal(impacts[0].cgpaWithoutCourse, 8);
  assert.equal(impacts[0].cgpaIfRepassedAtD, 8);
});

console.log(`\n${passed} checks passed.`);
