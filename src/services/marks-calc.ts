/**
 * Internal-assessment totals — pure math, no network, fully unit-testable.
 *
 * How VTOP scores a course
 * ------------------------
 * Every component is worth a slice of a 100-mark internal scale:
 *
 *   Mid Term (CAT-I 15 + CAT-II 15)        30
 *   Term End Examination (FAT)              30
 *   Attendance                             5   (only if attendance >= 75%)
 *   + lab and/or class assessments         35   (varies by course mode)
 *                                          ---
 *                                          100
 *
 * Verified against a completed semester (Winter 2025-26): all eight courses
 * summed to exactly 100 — PLA1006/CSD4007/MAT2003 (LTM), CSD4012/CSD5002 (LPM)
 * and CSD4002/CSE3006/CSE4001 (LTPM). So 100 is the denominator, not the
 * published sum.
 *
 * The columns
 * -----------
 *   maxMarks      raw marks the component is out of (a 50-mark Mid Term)
 *   maxWeightage  marks that component contributes to the 100 (the "Weightage %")
 *   weightage     marks YOU scored, already scaled: scored/maxMarks*maxWeightage
 *
 * (Confirmed live: Mid Term 25/50 shows weightage 15 = 25/50*30; Term End
 * 78/100 shows 23.4 = 78/100*30.)
 *
 * Why this module exists
 * ----------------------
 * VTOP omits components that have not been conducted yet instead of showing
 * them as zero, so a mid-semester page lists only part of the scale. Dividing
 * by the published sum flatters the student badly (28.8 of a published 30 reads
 * as 96% when it is 28.8% of the real 100). This module divides by 100 and,
 * using the course-mode templates below, names what is still outstanding.
 */

import type { MarksRecord } from "../types/index.js";

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** The full internal scale. Verified: every course mode sums to exactly 100. */
export const FULL_INTERNAL_SCALE = 100;

export interface ComponentTotal {
  component: string;
  maxMarks: number | null;
  /** null when unpublished — never a scored zero. */
  scored: number | null;
  maxWeightage: number | null;
  /** null when unpublished; contributes nothing to scoredSoFar. */
  weightage: number | null;
  /** Raw-score percentage for this component alone. */
  percent: number | null;
  status: string;
  /** True when the component counts toward the total but carries no mark yet. */
  pending: boolean;
}

export interface OutstandingComponent {
  label: string;
  marks: number;
}

export interface CourseInternalTotal {
  courseCode: string;
  courseName: string;
  courseType: string;
  courseMode: string;
  slot: string;
  components: ComponentTotal[];
  /** Marks scored so far, on the 100-mark internal scale. Exact. */
  scoredSoFar: number;
  /** The course's full internal scale. Always 100. */
  fullScale: number;
  /** scoredSoFar as a % of the full scale — a true lower bound on your mark. */
  percentOfScale: number;
  /** Marks still unaccounted for (unpublished components). */
  outstandingMarks: number;
  /** Best-effort names of what is still outstanding; empty if the mode is unknown. */
  outstanding: OutstandingComponent[];
  /** True when the published components add up to the full scale. */
  complete: boolean;
}

/**
 * The 5 attendance marks
 * ----------------------
 * Awarded on your attendance percentage, but the rule CHANGED:
 *
 *   - Up to and including Winter 2025-26: banded — 95%+ scores 5, 90%+ scores
 *     4, and 75% or less scores 0.
 *   - From Fall 2026-27: all or nothing — 5 marks at 75%+, otherwise 0.
 *
 * Rather than hardcode a semester cut-off, the rule is inferred from the marks
 * actually published: a component scored between 1 and 4 can only come from a
 * banded rule. Where the rule is banded we do NOT predict a number, because the
 * complete band table is not published here (only 95+/90+/<75% are known).
 */

export type AttendanceRule = "binary" | "banded" | "unknown";

/** Marks the Attendance component is out of. */
export const ATTENDANCE_MARKS = 5;
/** Below this, VIT awards no attendance marks at all. */
export const ATTENDANCE_CUTOFF_PERCENT = 75;

/**
 * First semester that awards attendance all-or-nothing. VIT Bhopal switched
 * from the banded rule to a binary 75%+ rule for Fall 2026-27; every earlier
 * semester is banded. Semester ids are fixed-width (BL + year + term + seq), so
 * a plain string comparison orders them correctly.
 */
export const BINARY_ATTENDANCE_FROM = "BL20262701";

/**
 * Infer the attendance rule from published Attendance components. A score of
 * 5 or 0 alone can't distinguish binary from banded; anything in between proves
 * banded.
 */
export function inferAttendanceRule(records: MarksRecord[]): AttendanceRule {
  for (const r of records) {
    for (const m of r.marks) {
      if (!/attendance/i.test(m.component)) continue;
      if (m.weightage != null && m.weightage > 0 && m.weightage < ATTENDANCE_MARKS) return "banded";
    }
  }
  return "unknown";
}

/**
 * The attendance rule in force for a semester.
 *
 * Published data wins when it is conclusive — a mid-band score can only come
 * from the banded rule, so it overrides the date-based default. Otherwise fall
 * back to the documented switchover, because "no attendance row published yet"
 * means the semester is simply early, not that the rule is unknowable. Without
 * this, every mid-semester query would refuse to forecast the 5 marks at stake.
 */
export function attendanceRuleFor(
  semesterId: string | null | undefined,
  records: MarksRecord[],
): AttendanceRule {
  const inferred = inferAttendanceRule(records);
  if (inferred === "banded") return "banded";
  if (!semesterId) return "unknown";
  const boundary =
    process.env.VTOP_BINARY_ATTENDANCE_FROM?.trim() || BINARY_ATTENDANCE_FROM;
  // The switchover date is only meaningful for same-campus fixed-width ids
  // (BL########). A lexicographic compare across campus prefixes ("CH…" >
  // "BL…") would misclassify pre-switchover terms as binary.
  const sameCampus =
    /^[A-Z]{2}\d{8}$/.test(semesterId) &&
    /^[A-Z]{2}\d{8}$/.test(boundary) &&
    semesterId.slice(0, 2) === boundary.slice(0, 2);
  if (!sameCampus) return "unknown";
  return semesterId >= boundary ? "binary" : "banded";
}

/**
 * Marks the attendance component is heading towards, or null when the rule
 * cannot be applied confidently. Under the banded rule only the ends of the
 * scale are known (95%+ = 5, 90%+ = 4, 75 and under = 0), so nothing is
 * predicted inside 75-89% rather than inventing a band.
 */
export function predictAttendanceMarks(
  percent: number | null | undefined,
  rule: AttendanceRule,
): number | null {
  if (percent === null || percent === undefined) return null;
  if (rule === "binary") {
    return percent >= ATTENDANCE_CUTOFF_PERCENT ? ATTENDANCE_MARKS : 0;
  }
  if (rule === "banded") {
    if (percent >= 95) return ATTENDANCE_MARKS;
    if (percent >= 90) return 4;
    if (percent < ATTENDANCE_CUTOFF_PERCENT) return 0;
    return null; // 75-89%: bands unknown, so decline rather than guess
  }
  return null;
}

export interface AttendanceForecast {
  /** Attendance percentage for the course, when available. */
  percent: number | null;
  /** Marks the attendance component is heading towards, if the rule allows. */
  expectedMarks: number | null;
  rule: AttendanceRule;
  /** True when the course already has a published Attendance component. */
  published: boolean;
  /**
   * Always true while outstanding: VTOP awards the attendance marks only after
   * the last instructional day, so this is a projection, not a settled score.
   */
  projection: boolean;
}

export function attendanceForecast(
  rec: MarksRecord,
  rule: AttendanceRule,
  percent: number | null,
): AttendanceForecast | null {
  // Only relevant while the component is still outstanding.
  const published = rec.marks.some(
    (m) => /attendance/i.test(m.component) && (m.weightage ?? 0) > 0,
  );
  if (published) return null;
  return {
    percent,
    expectedMarks: predictAttendanceMarks(percent, rule),
    rule,
    published: false,
    projection: true,
  };
}

export interface InternalTotalsSummary {
  semesterId: string | null;
  /**
   * Every subject with its full component breakdown. Returned FIRST so the
   * assistant reports the detail before any total.
   */
  courses: CourseInternalTotal[];
  /** Which attendance rule this data follows. */
  attendanceRule: AttendanceRule;
  /** Everything below is a TOTAL, and comes last. */
  totals: {
    coursesCounted: number;
    aggregateScored: number;
    aggregateScale: number;
    aggregatePercentOfScale: number | null;
    averagePercentOfScale: number | null;
  };
  note: string;
}

// --- course-mode templates -----------------------------------------------------
// Marks a course of each mode is expected to carry, summing to 100. Verified
// against a completed semester across all three modes.
export interface ModeTemplate {
  label: string;
  components: { key: string; marks: number }[];
}

const MID_TERM = { key: "Mid Term (CAT-I + CAT-II)", marks: 30 };
const TERM_END = { key: "Term End Examination", marks: 30 };
const ATTENDANCE = { key: "Attendance", marks: 5 };

export const MODE_TEMPLATES: Record<string, ModeTemplate> = {
  LTM: {
    label: "Lecture + Tutorial",
    components: [
      MID_TERM,
      { key: "Class Assessment - Tutorial", marks: 10 },
      { key: "Class Assessment - Quiz", marks: 10 },
      { key: "Class Assessment - Group Activity", marks: 5 },
      ATTENDANCE,
      { key: "Assignment", marks: 10 },
      TERM_END,
    ],
  },
  LPM: {
    label: "Lecture + Practical",
    components: [
      MID_TERM,
      { key: "Lab Assessment - Challenging Task", marks: 15 },
      { key: "Lab Assessment - Continuous Assessment", marks: 20 },
      ATTENDANCE,
      TERM_END,
    ],
  },
  LTPM: {
    label: "Lecture + Tutorial + Practical",
    components: [
      MID_TERM,
      { key: "Lab Assessment - Viva", marks: 5 },
      { key: "Lab Assessment - Challenging Task", marks: 10 },
      { key: "Lab Assessment - Continuous Assessment", marks: 10 },
      { key: "Class Assessment - Tutorial", marks: 5 },
      { key: "Class Assessment - Group Activity", marks: 5 },
      ATTENDANCE,
      TERM_END,
    ],
  },
};

/**
 * Which template bucket a published component belongs to.
 *
 * VTOP names the same thing two ways depending on timing: an in-progress
 * semester lists "Continous Assessment Test - I" and "... II" separately (15
 * each), while a completed one collapses them into a single "Mid Term" worth
 * 30. Both map to the same 30-mark bucket. Matching is fuzzy because VTOP
 * misspells "Assessment" as "Assesment" in several labels.
 */
function bucketFor(component: string): string | null {
  const c = component.toLowerCase().replace(/\s+/g, " ").trim();
  if (/mid\s*term/.test(c) || /assessment\s*test/.test(c) || /^cat/.test(c)) return "Mid Term (CAT-I + CAT-II)";
  if (/term\s*end/.test(c) || /\bfat\b/.test(c) || /final\s*exam/.test(c)) return "Term End Examination";
  if (/attendance/.test(c)) return "Attendance";
  if (/assignment/.test(c)) return "Assignment";
  if (/viva/.test(c)) return "Lab Assessment - Viva";
  if (/challenging/.test(c)) return "Lab Assessment - Challenging Task";
  if (/continuous\s*assess/.test(c)) return "Lab Assessment - Continuous Assessment";
  if (/quiz/.test(c)) return "Class Assessment - Quiz";
  if (/tutorial/.test(c)) return "Class Assessment - Tutorial";
  if (/group\s*activ/.test(c)) return "Class Assessment - Group Activity";
  return null;
}

export function templateFor(courseMode: string | undefined): ModeTemplate | null {
  if (!courseMode) return null;
  return MODE_TEMPLATES[courseMode.toUpperCase()] ?? null;
}

/**
 * A component row present in the page but carrying no mark. VTOP rarely emits
 * these (it normally omits the row), but if one appears with a real weightage
 * and a non-graded status, it is genuinely not yet scored.
 */
function isPending(maxWeightage: number | null, scored: number | null, weightage: number | null, status: string): boolean {
  if ((maxWeightage ?? 0) <= 0) return false;
  // Nulls count as zero here deliberately: a blank row with an ungraded
  // status is exactly what "pending" means, while a real scored 0 arrives
  // with a graded status and is excluded below.
  if ((scored ?? 0) > 0 || (weightage ?? 0) > 0) return false;
  // A component explicitly graded absent still has a mark of 0 — that is NOT
  // pending, it is a real (bad) score, so don't relabel it.
  if (/absent|present|fail|pass/i.test(status)) return false;
  return true;
}

export function courseTotals(rec: MarksRecord): CourseInternalTotal {
  const components: ComponentTotal[] = rec.marks.map((m) => ({
    component: m.component,
    maxMarks: m.maxMarks,
    scored: m.scored,
    maxWeightage: m.maxWeightage,
    weightage: m.weightage,
    percent: m.maxMarks != null && m.maxMarks > 0 && m.scored != null ? round2((m.scored / m.maxMarks) * 100) : null,
    status: m.status,
    pending: isPending(m.maxWeightage, m.scored, m.weightage, m.status),
  }));

  const scoredSoFar = round2(components.reduce((s, c) => s + (c.weightage ?? 0), 0));

  // How much of each template bucket has been published. Mid Term arrives as
  // either one 30-mark row or two 15-mark rows, so accumulate per bucket.
  const template = templateFor(rec.courseMode);
  const filled = new Map<string, number>();
  for (const c of components) {
    const bucket = bucketFor(c.component);
    if (!bucket) continue;
    filled.set(bucket, round2((filled.get(bucket) ?? 0) + (c.maxWeightage ?? 0)));
  }

  let outstanding: OutstandingComponent[] = [];
  if (template) {
    outstanding = template.components
      .map((t) => ({ label: t.key, marks: round2(t.marks - (filled.get(t.key) ?? 0)) }))
      .filter((o) => o.marks > 0.01);
  }

  // Trust the template's arithmetic for what is missing; fall back to the
  // raw scale difference when the mode is unknown.
  const fromTemplate = round2(outstanding.reduce((s, o) => s + o.marks, 0));
  const outstandingMarks = template
    ? fromTemplate
    : round2(Math.max(0, FULL_INTERNAL_SCALE - scoredSoFar));

  return {
    courseCode: rec.courseCode,
    courseName: rec.courseName,
    courseType: rec.courseType,
    courseMode: rec.courseMode ?? "",
    slot: rec.slot,
    components,
    scoredSoFar,
    fullScale: FULL_INTERNAL_SCALE,
    percentOfScale: round2((scoredSoFar / FULL_INTERNAL_SCALE) * 100),
    outstandingMarks,
    outstanding,
    complete: outstandingMarks <= 0.01,
  };
}

export function summariseInternals(
  records: MarksRecord[],
  semesterId: string | null = null,
): InternalTotalsSummary {
  const courses = records.map(courseTotals);
  const withMarks = courses.filter((c) => c.scoredSoFar > 0);
  const aggregateScored = round2(courses.reduce((s, c) => s + c.scoredSoFar, 0));
  const aggregateScale = round2(courses.length * FULL_INTERNAL_SCALE);
  const attendanceRule = attendanceRuleFor(semesterId, records);

  return {
    semesterId,
    courses,
    attendanceRule,
    // Totals last: the detail above is what the user wants read out first.
    totals: {
      coursesCounted: courses.length,
      aggregateScored,
      aggregateScale,
      aggregatePercentOfScale:
        aggregateScale > 0 ? round2((aggregateScored / aggregateScale) * 100) : null,
      averagePercentOfScale:
        withMarks.length > 0
          ? round2(withMarks.reduce((s, c) => s + c.percentOfScale, 0) / withMarks.length)
          : null,
    },
    note:
      "How to read this. The course total is out of 100, made up of: internal " +
      "assessment 40 (lab/class assessments 35 + attendance 5, awarded only at " +
      "75%+ attendance), mid-term CAT-I 15 + CAT-II 15 = 30, and the Term End " +
      "Examination 30. Marks SCORED are exact. `outstanding` lists components " +
      "with no mark on VTOP - that usually means the faculty member has not " +
      "published them yet rather than that they are unconducted, and it also " +
      "covers anything genuinely still to come. Either way your marks can only " +
      "rise from scoredSoFar. The attendance marks are awarded only after the " +
      "last instructional day, so `attendanceForecast` is a PROJECTION based on " +
      "your attendance right now - it is not a settled score. IMPORTANT: the " +
      "letter grade is awarded RELATIVELY against the class average, so a 100 " +
      "mark total does not map directly to an S/A/B - a strong cohort makes the " +
      "same marks worth less.",
  };
}