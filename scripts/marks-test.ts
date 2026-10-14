#!/usr/bin/env tsx
/**
 * Offline tests for the internal-marks totals calculator.
 *   npm run test:marks
 *
 * The fixtures are REAL completed-semester rows (Winter 2025-26) copied from
 * VTOP, so the 100-mark scale and the three course-mode templates are pinned to
 * observed reality rather than to an assumption.
 */
import assert from "node:assert/strict";
import {
  courseTotals,
  summariseInternals,
  templateFor,
  attendanceRuleFor,
  inferAttendanceRule,
  predictAttendanceMarks,
  attendanceForecast,
  FULL_INTERNAL_SCALE,
  ATTENDANCE_MARKS,
} from "../src/services/marks-calc.js";
import type { MarksRecord } from "../src/types/index.js";

let passed = 0;
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

const c = (
  component: string,
  maxMarks: number | null,
  scored: number | null,
  maxWeightage: number | null,
  weightage: number | null,
  status = "Present",
) => ({ component, maxMarks, scored, maxWeightage, weightage, average: null as number | null, status });

const rec = (
  courseCode: string,
  courseMode: string,
  marks: MarksRecord["marks"],
): MarksRecord => ({
  courseCode,
  courseName: `${courseCode} Name`,
  courseType: "Lecture and Tutorial Hours Only",
  courseMode,
  slot: "B21",
  marks,
});

// ============================================================================
// REAL completed-semester fixtures. Every one of these must total 100.
// ============================================================================
const PLA1006 = rec("PLA1006", "LTM", [
  c("Mid Term", 50, 25, 30, 15),
  c("Class Assesment - Tutorial", 10, 8, 10, 8),
  c("Class Assesment - Quiz", 10, 10, 10, 10),
  c("Class Assesment - Group Activity", 5, 5, 5, 5),
  c("Attendance", 5, 3, 5, 3),
  c("Assignment", 10, 10, 10, 10),
  c("Term End Examination", 100, 78, 30, 23.4),
]);

const CSD4012 = rec("CSD4012", "LPM", [
  c("Mid Term", 50, 43, 30, 25.8),
  c("Lab Assessment - Challenging Task", 15, 15, 15, 15),
  c("Lab Assessment - Continuous Assessment", 20, 20, 20, 20),
  c("Attendance", 5, 5, 5, 5),
  c("Term End Examination", 100, 90, 30, 27),
]);

const CSD4002 = rec("CSD4002", "LTPM", [
  c("Mid Term", 50, 49, 30, 29.4),
  c("Lab Assessment - Viva", 5, 5, 5, 5),
  c("Lab Assessment - Challenging Task", 10, 10, 10, 10),
  c("Lab Assessment - Continuous Assessment", 10, 10, 10, 10),
  c("Class Assesment - Tutorial", 5, 5, 5, 5),
  c("Class Assesment - Group Activity", 5, 5, 5, 5),
  c("Attendance", 5, 5, 5, 5),
  c("Term End Examination", 100, 93, 30, 27.9),
]);

const CSE3006 = rec("CSE3006", "LTPM", [
  c("Mid Term", 50, 27, 30, 16.2),
  c("Lab Assessment - Viva", 5, 5, 5, 5),
  c("Lab Assessment - Challenging Task", 10, 8, 10, 8),
  c("Lab Assessment - Continuous Assessment", 10, 7, 10, 7),
  c("Class Assesment - Tutorial", 5, 5, 5, 5),
  c("Class Assesment - Group Activity", 5, 3.5, 5, 3.5),
  c("Attendance", 5, 4, 5, 4),
  c("Term End Examination", 100, 72, 30, 21.6),
]);

/** MAT2003's shape: attendance 4/5 — another mid-band score. */
const MAT2003_LIKE = rec("MAT2003", "LTM", [
  c("Mid Term", 50, 26, 30, 15.6),
  c("Class Assesment - Tutorial", 10, 10, 10, 10),
  c("Class Assesment - Quiz", 10, 10, 10, 10),
  c("Class Assesment - Group Activity", 5, 5, 5, 5),
  c("Attendance", 5, 4, 5, 4),
  c("Assignment", 10, 10, 10, 10),
  c("Term End Examination", 100, 87, 30, 26.1),
]);

// ============================================================================
// The 100-mark scale, proven against every real fixture.
// ============================================================================
check("every completed course totals exactly 100", () => {
  for (const r of [PLA1006, CSD4012, CSD4002, CSE3006]) {
    const sum = r.marks.reduce((s, m) => s + m.maxWeightage, 0);
    assert.equal(sum, 100, `${r.courseCode} component weightages should total 100`);
  }
});

check("all three mode templates sum to 100", () => {
  for (const mode of ["LTM", "LPM", "LTPM"]) {
    const sum = templateFor(mode)!.components.reduce((s, x) => s + x.marks, 0);
    assert.equal(sum, 100, `${mode} template should total 100`);
  }
});

check("FULL_INTERNAL_SCALE is 100", () => {
  assert.equal(FULL_INTERNAL_SCALE, 100);
});

check("a completed course reports complete with nothing outstanding", () => {
  const t = courseTotals(PLA1006);
  assert.equal(t.scoredSoFar, 74.4); // 15+8+10+5+3+10+23.4
  assert.equal(t.outstandingMarks, 0);
  assert.deepEqual(t.outstanding, []);
  assert.equal(t.complete, true);
  assert.equal(t.percentOfScale, 74.4);
});

check("weightage is scored/maxMarks * maxWeightage", () => {
  const t = courseTotals(PLA1006);
  const mid = t.components[0];
  assert.equal(mid.maxMarks, 50);
  assert.equal(mid.scored, 25);
  assert.equal(mid.weightage, 15); // 25/50*30
  assert.equal(mid.percent, 50);
  const fat = t.components[6];
  assert.equal(fat.weightage, 23.4); // 78/100*30
});

// ============================================================================
// The in-progress case: VTOP omits unconducted rows entirely.
// ============================================================================
check("mid-term CAT-I/CAT-II pair counts as one 30-mark Mid Term", () => {
  const t = courseTotals(
    rec("ABC101", "LTM", [
      c("Continous Assessment Test - II", 50, 31, 15, 9.3),
      c("Continous Assessment Test - I", 50, 28, 15, 8.4),
    ]),
  );
  // Mid Term bucket is 30 and fully published, so it must NOT be outstanding.
  assert.equal(t.scoredSoFar, 17.7);
  assert.equal(
    t.outstanding.find((o) => o.label.includes("Mid Term")),
    undefined,
    "CAT-I + CAT-II together fill the Mid Term bucket",
  );
});

check("outstanding names what is still to come", () => {
  const t = courseTotals(
    rec("ABC101", "LTM", [
      c("Continous Assessment Test - II", 50, 31, 15, 9.3),
      c("Continous Assessment Test - I", 50, 28, 15, 8.4),
    ]),
  );
  const labels = t.outstanding.map((o) => o.label);
  assert.ok(labels.includes("Class Assessment - Tutorial"));
  assert.ok(labels.includes("Class Assessment - Quiz"));
  assert.ok(labels.includes("Attendance"));
  assert.ok(labels.includes("Term End Examination"));
  assert.ok(!labels.includes("Mid Term (CAT-I + CAT-II)"));
  // Everything missing must add up to 100 - 30.
  assert.equal(t.outstandingMarks, 70);
  assert.equal(t.outstanding.reduce((s, o) => s + o.marks, 0), 70);
});

check("percentage is against the full 100, not the published sum", () => {
  // The bug this guards: 17.7 of a published 30 used to report as ~59%.
  const t = courseTotals(
    rec("ABC101", "LTM", [
      c("Continous Assessment Test - II", 50, 31, 15, 9.3),
      c("Continous Assessment Test - I", 50, 28, 15, 8.4),
    ]),
  );
  assert.equal(t.percentOfScale, 17.7);
  assert.notEqual(t.percentOfScale, 96);
});

check("LTPM mid-semester course reports against 100", () => {
  const t = courseTotals(
    rec("ABC105", "LTPM", [
      c("Lab Assessment - Viva", 5, 5, 5, 5),
      c("Lab Assessment - Challenging Task", 10, 10, 10, 10),
      c("Lab Assessment - Continuous Assessment", 10, 7, 10, 7),
      c("Continous Assessment Test - II", 50, 26, 15, 7.8),
      c("Continous Assessment Test - I", 50, 31, 15, 9.3),
      c("Class Assesment - Tutorial", 5, 5, 5, 5),
      c("Class Assesment - Group Activity", 5, 5, 5, 5),
    ]),
  );
  assert.equal(t.scoredSoFar, 49.1);
  assert.equal(t.percentOfScale, 49.1);
  // Attendance (5) and Term End (30) are unpublished.
  assert.equal(t.outstandingMarks, 35);
  const labels = t.outstanding.map((o) => o.label);
  assert.ok(labels.includes("Attendance"));
  assert.ok(labels.includes("Term End Examination"));
});

check("unknown course mode still divides by 100", () => {
  const t = courseTotals(rec("XXXX", "", [c("Something", 50, 20, 30, 12)]));
  assert.equal(t.scoredSoFar, 12);
  assert.equal(t.percentOfScale, 12);
  assert.deepEqual(t.outstanding, []);
  assert.equal(t.outstandingMarks, 88); // falls back to the raw difference
});

// ============================================================================
// Pending vs genuinely absent.
// ============================================================================
check("an ABSENT component is a real zero, not pending", () => {
  const t = courseTotals(rec("Z", "LTM", [c("Attendance", 5, 0, 5, 0, "Absent")]));
  assert.equal(t.components[0].pending, false);
  assert.equal(t.scoredSoFar, 0);
});

check("a listed but ungraded component is flagged pending", () => {
  const t = courseTotals(rec("Y", "LTM", [c("FAT", 100, 0, 30, 0, "-")]));
  assert.equal(t.components[0].pending, true);
});

check("a blank (unpublished) component scores null, stays pending, banks nothing", () => {
  // The parser emits null for blank cells; totals must treat them as
  // unpublished — visible as pending with no banked marks, never as a
  // scored zero.
  const t = courseTotals(rec("Y", "LTM", [c("FAT", 100, null, 30, null, "-")]));
  assert.equal(t.components[0].scored, null);
  assert.equal(t.components[0].weightage, null);
  assert.equal(t.components[0].pending, true);
  assert.equal(t.scoredSoFar, 0);
});

check("VTOP's 'Assesment' misspelling still buckets correctly", () => {
  const t = courseTotals(
    rec("W", "LTPM", [
      c("Class Assesment - Tutorial", 5, 5, 5, 5),
      c("Class Assesment - Group Activity", 5, 0, 5, 0, "Absent"),
    ]),
  );
  const labels = t.outstanding.map((o) => o.label);
  assert.ok(!labels.includes("Class Assessment - Tutorial"), "misspelled Tutorial matched");
  assert.ok(!labels.includes("Class Assessment - Group Activity"), "misspelled Group matched");
});

// ============================================================================
// Summary aggregation over the real fixtures.
// ============================================================================
check("summary aggregates real courses against 100 each", () => {
  // Per-course marks verified by hand from the VTOP rows:
  //   PLA1006 15+8+10+5+3+10+23.4 = 74.4
  //   CSD4012 25.8+15+20+5+27     = 92.8
  //   CSD4002 29.4+5+10+10+5+5+5+27.9 = 97.3
  //   CSE3006 16.2+5+8+7+5+3.5+4+21.6 = 70.3
  assert.equal(courseTotals(PLA1006).scoredSoFar, 74.4);
  assert.equal(courseTotals(CSD4012).scoredSoFar, 92.8);
  assert.equal(courseTotals(CSD4002).scoredSoFar, 97.3);
  assert.equal(courseTotals(CSE3006).scoredSoFar, 70.3);

  const s = summariseInternals([PLA1006, CSD4012, CSD4002, CSE3006]);
  assert.equal(s.totals.coursesCounted, 4);
  assert.equal(s.totals.aggregateScale, 400);
  assert.equal(s.totals.aggregateScored, 334.8);
  assert.equal(s.totals.aggregatePercentOfScale, 83.7); // 334.8/400
  assert.equal(s.totals.averagePercentOfScale, 83.7); // every scale is 100, so mean == aggregate
});


check("empty input does not divide by zero", () => {
  const s = summariseInternals([]);
  assert.equal(s.totals.aggregatePercentOfScale, null);
  assert.equal(s.totals.averagePercentOfScale, null);
  assert.equal(s.totals.coursesCounted, 0);
});

// ============================================================================
// The attendance component: 5 marks, rule changed this semester.
//   previous semesters: banded (95+ = 5, 90+ = 4, 75 and under = 0)
//   this semester:     all or nothing at 75%+
// ============================================================================
check("a mid-band attendance score proves the rule is banded", () => {
  // PLA1006 scored 3/5 and MAT2003 4/5 — a binary rule cannot produce those.
  assert.equal(inferAttendanceRule([PLA1006]), "banded");
  assert.equal(inferAttendanceRule([MAT2003_LIKE]), "banded");
});

check("only 5s and 0s leave the rule undetermined", () => {
  assert.equal(inferAttendanceRule([CSD4002]), "unknown"); // 5/5
  const zeroes = rec("Z", "LTM", [c("Attendance", 5, 0, 5, 0, "Absent")]);
  assert.equal(inferAttendanceRule([zeroes]), "unknown");
});

check("no attendance component at all -> unknown", () => {
  assert.equal(
    inferAttendanceRule([
      rec("N", "LTM", [c("Continous Assessment Test - I", 50, 40, 15, 12)]),
    ]),
    "unknown",
  );
});

check("binary rule: 75%+ scores the full 5, under scores 0", () => {
  assert.equal(predictAttendanceMarks(75, "binary"), 5);
  assert.equal(predictAttendanceMarks(74.9, "binary"), 0);
  assert.equal(predictAttendanceMarks(91.4, "binary"), ATTENDANCE_MARKS);
});

check("banded rule predicts only the known bands", () => {
  // Confirmed bands: 95+ = 5, 90+ = 4, 75 and under = 0. The 75-89% bands are
  // not published, so nothing is predicted there rather than inventing one.
  assert.equal(predictAttendanceMarks(96, "banded"), 5);
  assert.equal(predictAttendanceMarks(91, "banded"), 4);
  assert.equal(predictAttendanceMarks(74, "banded"), 0);
  assert.equal(predictAttendanceMarks(86, "banded"), null);
});

check("rule falls back to the semester when nothing is published yet", () => {
  // No Attendance row at all is normal mid-semester; it must NOT mean unknown.
  const early = [rec("ABC105", "LTPM", [c("Continous Assessment Test - I", 50, 40, 15, 12)])];
  assert.equal(attendanceRuleFor("BL20262701", early), "binary");
  assert.equal(attendanceRuleFor("BL20262705", early), "binary");
  assert.equal(attendanceRuleFor("BL20252605", early), "banded");
  assert.equal(attendanceRuleFor("BL20242501", early), "banded");
});

check("published data overrides the semester default", () => {
  // A mid-band score can only come from the banded rule, so it wins even for a
  // semester that defaults to binary.
  assert.equal(attendanceRuleFor("BL20262701", [PLA1006]), "banded");
});

check("no semester and no data -> unknown", () => {
  const early = [rec("C", "LTM", [c("Mid Term", 50, 40, 30, 24)])];
  assert.equal(attendanceRuleFor(null, early), "unknown");
  assert.equal(attendanceRuleFor(undefined, early), "unknown");
});

check("unknown attendance -> no forecast", () => {
  assert.equal(predictAttendanceMarks(90, "unknown"), null);
  assert.equal(predictAttendanceMarks(null, "binary"), null);
  assert.equal(predictAttendanceMarks(undefined, "binary"), null);
});

check("forecast is omitted once attendance is published", () => {
  // PLA1006 already has Attendance 3/5, so there is nothing to forecast.
  assert.equal(attendanceForecast(PLA1006, "banded", 88), null);
});

check("forecast appears only while attendance is outstanding", () => {
  const pending = rec("ABC105", "LTPM", [c("Mid Term", 50, 40, 30, 24)]);
  const f = attendanceForecast(pending, "binary", 86.1);
  assert.ok(f);
  assert.equal(f.percent, 86.1);
  assert.equal(f.expectedMarks, 5);
  assert.equal(f.rule, "binary");
});

check("attendance forecast is flagged as a projection", () => {
  // VTOP awards these marks only after the last instructional day, so it must
  // never read as a settled score.
  const f = attendanceForecast(
    rec("ABC105", "LTPM", [c("Mid Term", 50, 40, 30, 24)]),
    "binary",
    86.1,
  );
  assert.equal(f!.projection, true);
});

check("note distinguishes unpublished from unconducted", () => {
  const n = summariseInternals([]).note;
  assert.match(n, /has not published them yet rather than that they are unconducted/);
});

check("note says attendance marks are awarded after the last instructional day", () => {
  assert.match(
    summariseInternals([]).note,
    /awarded only after the last instructional day/,
  );
});

// ============================================================================
// Reporting shape: every subject first, totals last.
// ============================================================================
check("summary puts totals last so detail is read first", () => {
  const s = summariseInternals([PLA1006, CSD4012]);
  const keys = Object.keys(s);
  assert.ok(keys.indexOf("courses") < keys.indexOf("totals"), "courses must precede totals");
  assert.equal(s.totals.coursesCounted, 2);
  assert.equal(s.totals.aggregateScale, 200);
  assert.equal(s.totals.aggregateScored, 74.4 + 92.8);
  assert.equal(s.totals.aggregatePercentOfScale, 83.6); // 167.2/200
  assert.equal(s.attendanceRule, "banded");
});

check("summary note states the 40 internal + 30 CAT + 30 FAT split", () => {
  const n = summariseInternals([]).note;
  assert.match(n, /internal assessment 40 \(lab\/class assessments 35 \+ attendance 5/);
  assert.match(n, /CAT-I 15 \+ CAT-II 15 = 30/);
  assert.match(n, /Term End Examination 30/);
});

check("summary note warns the grade is relative, not absolute", () => {
  // A 100-mark total does not map to S/A/B - the cohort matters.
  const n = summariseInternals([]).note;
  assert.match(n, /RELATIVELY against the class average/);
  assert.match(n, /does not map directly to an S\/A\/B/);
});

console.log(`\n${passed} checks passed.`);
