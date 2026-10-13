/**
 * Pass-eligibility rules — pure maths, no network, fully unit-testable.
 *
 * VIT Bhopal course scoring, out of 100 (confirmed by the student):
 *
 *   CAT-I (Closed Book)    50 raw marks -> 15 of 100
 *   CAT-II (Open Book)     50 raw marks -> 15 of 100
 *   CAM (continuous)       includes the 5 attendance marks -> 40 of 100
 *   Term End Examination  100 raw marks -> 30 of 100
 *
 * The passing total, in RAW marks, is fixed at 80 of the 200 available:
 *
 *      CAT-I 20 + CAT-II 20 + FAT 40 = 80   (out of 50 + 50 + 100 = 200)
 *
 * The end goal is always the FAT's own 40/100. What varies is how much MORE
 * than 40 the FAT has to score, because any shortfall in the CATs is added to
 * it.
 *
 * The transfer is NET across the two CATs, not per-CAT. They need 40 between
 * them (20 each), so a CAT scored above 20 offsets one scored below it:
 *
 *      CAT-I 20 + CAT-II 20  ->  sum 40  ->  no deficit  ->  FAT >= 40
 *      CAT-I 10 + CAT-II 10  ->  sum 20  ->  20 deficit   ->  FAT >= 60
 *      CAT-I 30 + CAT-II 10  ->  sum 40  ->  no deficit   ->  FAT >= 40
 *      CAT-I  0 + CAT-II  0  ->  sum  0  ->  40 deficit   ->  FAT >= 80
 *
 * So the raw total lands on exactly 80 whenever the CATs reach at most 40
 * combined, and above 80 when they exceed it. The deficit does not add marks;
 * it changes where the shortfall is made up.
 *
 * A CAT not attempted counts as 0, transferring its full share.
 *
 * Because the total is conserved, this is equivalently a single rule:
 *
 *      CAT-I + CAT-II + FAT  >=  80  (raw)
 *
 * Both formulations are implemented below and cross-checked in the tests.
 *
 * There is NO RE-TEST for CAT-I, CAT-II or the TEE. A shortfall is permanent;
 * it can only ever be made up in the FAT.
 *
 * Attendance: >= 75.0% to sit CAT-I, CAT-II AND the TEE (exactly 75.0%
 * qualifies). Attendance is also worth 5 marks inside CAM under an
 * all-or-nothing rule, so falling below 75% costs those marks too.
 */

import type { CalendarDay, Weekday } from "./attendance-calc.js";

// --- the raw-mark rules ----------------------------------------------------

/** Raw marks that count toward passing in each CAT (out of 50). */
export const CAT_PASS_RAW = 20;
export const CAT_MAX_RAW = 50;
/** Marks each CAT contributes to the 100-point course scale. */
export const CAT_WEIGHTAGE = 15;

export const FAT_MAX_RAW = 100;
/** Marks the FAT contributes to the 100-point course scale. */
export const FAT_WEIGHTAGE = 30;

/** The FAT's own end goal, before any CAT deficit is added. */
export const FAT_BASE_RAW = 40;

/** Raw marks available across the three components. */
export const RAW_TOTAL_AVAILABLE = CAT_MAX_RAW + CAT_MAX_RAW + FAT_MAX_RAW; // 200

/** Raw marks needed overall: 20 + 20 + 40. */
export const RAW_PASS_TOTAL =
  CAT_PASS_RAW + CAT_PASS_RAW + FAT_BASE_RAW; // 80

/** Attendance percentage required to sit any exam. Exactly 75.0% qualifies. */
export const ATTENDANCE_GATE_PERCENT = 75;

const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Marks of deficit the CATs contribute TOGETHER: how far the combined CAT
 * score falls short of the 40 needed (20 each).
 *
 * This is a NET figure, not a per-CAT sum. A CAT scored above 20 offsets a
 * CAT scored below it — CAT-I 30 with CAT-II 10 gives a combined 40, which is
 * exactly what the two CATs need to contribute, so no deficit is transferred
 * and the FAT stays at 40. Summing per-CAT shortfalls would wrongly charge 10
 * extra to the FAT there and inflate the raw total to 90.
 *
 * An unattempted CAT counts as 0, so a missed CAT transfers its full share.
 */
export function catDeficit(catRaws: (number | null)[]): number {
  const scored = catRaws.reduce<number>((s, r) => s + (r ?? 0), 0);
  const needed = CAT_PASS_RAW * catRaws.length;
  return Math.max(0, needed - scored);
}

/**
 * Raw marks the FAT must score, given what the CATs scored between them.
 *
 * The CATs' combined shortfall is added to the FAT's own 40, so the overall raw
 * total always lands on exactly 80 (or higher, when the CATs exceed 40).
 */
export function requiredFatRaw(catRaws: (number | null)[]): number {
  return FAT_BASE_RAW + catDeficit(catRaws);
}

/**
 * The same rule as a single inequality over the raw total: 80 of 200.
 * Provided so callers (and tests) can cross-check the two formulations.
 */
export function rawTotalPasses(
  catRaws: (number | null)[],
  fatRaw: number | null,
): boolean {
  if (fatRaw === null) return false;
  const total =
    catRaws.reduce<number>((s, r) => s + (r ?? 0), 0) + fatRaw;
  return total >= RAW_PASS_TOTAL;
}

/** Marks a raw score contributes to the 100-point course scale. */
export function weightedMarks(raw: number, rawMax: number, weightage: number): number {
  if (rawMax <= 0) return 0;
  return round2((raw / rawMax) * weightage);
}

// --- a single CAT ----------------------------------------------------------

export type CatStatus = "passed" | "failed" | "missed";

export interface CatAssessment {
  /** "CAT-I" / "CAT-II" for reporting. */
  label: string;
  /** Raw score, or null when the CAT was not attempted (no mark published). */
  raw: number | null;
}

export interface CatVerdict {
  label: string;
  status: CatStatus;
  /** Raw score on the CAT paper, or null when never attempted. */
  raw: number | null;
  /** The CAT paper is marked out of 50. */
  rawMax: number;
  /** Raw marks this CAT needs: 20 of 50. */
  neededRaw: number;
  /** What that minimum is worth on the 100-point course scale, out of 15. */
  neededMarks: number;
  /** Marks this CAT contributes to the 100-scale (0 when missed or failed). */
  marks: number;
  /** Marks this CAT fell short of its own 20 minimum. Per-CAT, pre-offset. */
  ownShortfall: number;
  /** Both scales in one sentence, so neither can be misread alone. */
  requirement: string;
}

export function assessCat(cat: CatAssessment): CatVerdict {
  const ownShortfall = Math.max(0, CAT_PASS_RAW - (cat.raw ?? 0));
  const neededMarks = weightedMarks(CAT_PASS_RAW, CAT_MAX_RAW, CAT_WEIGHTAGE);
  const requirement =
    `${CAT_PASS_RAW}/${CAT_MAX_RAW} raw, worth ${neededMarks} of the ` +
    `${CAT_WEIGHTAGE} marks this CAT carries on the 100-point scale`;

  if (cat.raw === null) {
    return {
      label: cat.label,
      status: "missed",
      raw: null,
      rawMax: CAT_MAX_RAW,
      neededRaw: CAT_PASS_RAW,
      neededMarks,
      marks: 0,
      ownShortfall,
      requirement,
    };
  }
  const passed = cat.raw >= CAT_PASS_RAW;
  return {
    label: cat.label,
    status: passed ? "passed" : "failed",
    raw: cat.raw,
    rawMax: CAT_MAX_RAW,
    neededRaw: CAT_PASS_RAW,
    neededMarks,
    // A failed CAT scores nothing toward passing, but its shortfall can still
    // transfer to the FAT if the other CAT does not cover it.
    marks: passed ? weightedMarks(cat.raw, CAT_MAX_RAW, CAT_WEIGHTAGE) : 0,
    ownShortfall,
    requirement,
  };
}

// --- the whole course ------------------------------------------------------

export interface PassVerdict {
  cats: CatVerdict[];
  /** CATs that were not attempted at all. */
  missedCats: number;
  /** Combined raw score across both CATs. */
  catRawSum: number;
  /** Marks of NET CAT shortfall transferred onto the FAT (0 if offset). */
  totalDeficit: number;
  /** Marks the CATs scored above the 40 they jointly need, offsetting a deficit. */
  catSurplus: number;
  /**
   * What the TEE (FAT) must score: raw marks out of 100 on the paper. This is
   * the headline number - it is what the student is asked for when they ask
   * "what do I need in the FAT".
   */
  teeRequiredRaw: number;
  /** The TEE paper is marked out of 100. */
  teeRawMax: number;
  /** What that TEE minimum is worth on the 100-point course scale, out of 30. */
  teeRequiredMarks: number;
  /** Raw marks actually scored in the TEE, or null when not yet taken. */
  teeRaw: number | null;
  /** Marks the CATs contribute to the 100-scale. */
  catMarks: number;
  /** Marks the TEE contributes, or null when not yet taken. */
  teeMarks: number | null;
  /** Marks already banked out of 100, across every published component. */
  bankedSoFar: number | null;
  /** Raw marks scored across CAT-I + CAT-II + TEE so far. */
  rawTotalSoFar: number | null;
  /** Raw marks needed overall (80 of 200). */
  rawTotalRequired: number;
  /**
   * The final course total you finish with IF you score exactly the TEE
   * minimum - an outcome, NOT a requirement. It is `bankedSoFar` plus
   * `teeRequiredMarks`; the TEE marks are already inside the banked total, so
   * they are not added twice.
   *
   * The attendance marks are NOT included: they are a projection, awarded only
   * once the last instructional day has passed.
   */
  totalIfTeeClearedAtMinimum: number | null;
  canPass: boolean | null;
  /** Hard blockers: rules already broken beyond recovery. */
  blockers: string[];
  /** Non-blocking notes, e.g. a CAT under 20 whose shortfall moved to the TEE. */
  advisories: string[];
  /** The TEE requirement in both scales, in one sentence. */
  teeRequirement: string;
  explanation: string;
}

export function assessCourse(
  cats: CatAssessment[],
  fatRaw: number | null,
  opts: { scoredSoFar?: number | null; attendancePercent?: number | null } = {},
): PassVerdict {
  const verdicts = cats.map(assessCat);
  const missedCats = verdicts.filter((c) => c.status === "missed").length;
  const raws = verdicts.map((c) => c.raw);
  // NET across both CATs: a strong CAT offsets a weak one.
  const totalDeficit = catDeficit(raws);
  const catSum = raws.reduce<number>((s, r) => s + (r ?? 0), 0);
  const catSurplus = Math.max(0, catSum - CAT_PASS_RAW * raws.length);

  const teeRequiredRaw = FAT_BASE_RAW + totalDeficit;
  const teeRequiredMarks = weightedMarks(teeRequiredRaw, FAT_MAX_RAW, FAT_WEIGHTAGE);
  const catMarks = round2(verdicts.reduce<number>((s, c) => s + c.marks, 0));
  const teeMarks =
    fatRaw === null ? null : weightedMarks(fatRaw, FAT_MAX_RAW, FAT_WEIGHTAGE);

  const teeRequirement =
    `${teeRequiredRaw}/${FAT_MAX_RAW} on the TEE paper, worth ${teeRequiredMarks} ` +
    `of the ${FAT_WEIGHTAGE} marks the TEE carries on the 100-point course scale`;

  const rawTotalSoFar = fatRaw === null
    ? null
    : round2(verdicts.reduce<number>((s, c) => s + (c.raw ?? 0), 0) + fatRaw);

  // A CAT below 20 is NOT a blocker on its own. The rule is a shortfall
  // transfer, not a hard per-component gate: scoring 10 moves 10 marks of
  // requirement onto the TEE, and the course still passes if the TEE makes it
  // up to reach 80 raw overall. Only a MISSED CAT is called out separately,
  // because it carries no mark at all and cannot be recovered (no re-test).
  const blockers: string[] = [];
  for (const c of verdicts) {
    if (c.status === "failed") {
      // Advisory, not a blocker: carried in `advisories` below.
      continue;
    }
    if (c.status === "missed") {
      blockers.push(
        `${c.label} was not attempted, so it scores 0. There is no re-test; ` +
          `its share of the shortfall can only be made up in the TEE.`,
      );
    }
  }
  if (fatRaw !== null && fatRaw < teeRequiredRaw) {
    blockers.push(
      `Term End Examination short: ${fatRaw}/${FAT_MAX_RAW} is below the ${teeRequiredRaw} needed` +
        (totalDeficit
          ? ` (${FAT_BASE_RAW} base + ${totalDeficit} of CAT shortfall).`
          : ".") +
        ` That minimum is worth ${teeRequiredMarks} of the ${FAT_WEIGHTAGE} TEE marks.`,
    );
  }

  // `scoredSoFar` is the sum of every component VTOP has published a mark for,
  // on the 100-point scale. That ALREADY INCLUDES the CATs once they are
  // scored, so the projected final total is just what you have banked plus the
  // TEE at its threshold - adding `catMarks` again would double-count them and
  // overstate the figure by the whole CAT contribution.
  const scored = opts.scoredSoFar ?? null;
  const totalIfTeeClearedAtMinimum =
    scored === null ? null : round2(scored + teeRequiredMarks);

  const attendanceOk =
    opts.attendancePercent === undefined || opts.attendancePercent === null
      ? null
      : opts.attendancePercent >= ATTENDANCE_GATE_PERCENT;
  if (attendanceOk === false) {
    blockers.push(
      `Attendance ${opts.attendancePercent}% is below the ${ATTENDANCE_GATE_PERCENT}% needed to sit an exam.`,
    );
  }

  const advisories: string[] = [];
  for (const c of verdicts) {
    if (c.status === "failed") {
      const offset =
        catSurplus > 0
          ? ` It is covered by the surplus on the other CAT, so nothing is transferred to the TEE.`
          : c.ownShortfall > 0
            ? ` That ${c.ownShortfall}-mark shortfall is added to the TEE requirement.`
            : "";
      advisories.push(
        `${c.label} scored ${c.raw}/${CAT_MAX_RAW}, below the ${CAT_PASS_RAW} needed ` +
          `(that minimum is worth ${c.neededMarks} of ${CAT_WEIGHTAGE}).${offset}`,
      );
    }
  }

  // Cross-check the two equivalent formulations; they must never disagree.
  const byTotal =
    fatRaw === null ? null : rawTotalPasses(verdicts.map((c) => c.raw), fatRaw);

  let canPass: boolean | null;
  if (fatRaw === null) {
    // TEE still ahead: reachable unless something is already broken.
    const alreadyBroken = attendanceOk === false || missedCats > 0;
    canPass = alreadyBroken ? false : null;
  } else {
    const byMinimum = fatRaw >= teeRequiredRaw;
    if (byMinimum !== byTotal) {
      // Should be unreachable; surface it rather than silently picking one.
      throw new Error(
        `internal rule mismatch: fat ${fatRaw} vs required ${teeRequiredRaw} ` +
          `disagrees with the 80-of-200 total check`,
      );
    }
    canPass = blockers.length === 0;
  }

  const explanation =
    `Passing is ${RAW_PASS_TOTAL} raw marks out of ${RAW_TOTAL_AVAILABLE} ` +
    `(CAT-I ${CAT_PASS_RAW} + CAT-II ${CAT_PASS_RAW} + TEE ${FAT_BASE_RAW}). ` +
    `Each CAT is a ${CAT_MAX_RAW}-mark paper needing ${CAT_PASS_RAW}, and that ` +
    `minimum is worth ${weightedMarks(CAT_PASS_RAW, CAT_MAX_RAW, CAT_WEIGHTAGE)} ` +
    `of the ${CAT_WEIGHTAGE} each CAT carries. The TEE is a ${FAT_MAX_RAW}-mark ` +
    `paper worth ${FAT_WEIGHTAGE} of 100, and it must reach ${teeRequiredRaw} here` +
    (totalDeficit
      ? ` (${FAT_BASE_RAW} base + ${totalDeficit} carried from the CATs).`
      : ".") +
    ` Attendance gate: ${ATTENDANCE_GATE_PERCENT}% or more to sit an exam.`;

  return {
    cats: verdicts,
    missedCats,
    catRawSum: catSum,
    totalDeficit,
    catSurplus,
    teeRequiredRaw,
    teeRawMax: FAT_MAX_RAW,
    teeRequiredMarks,
    teeRaw: fatRaw,
    catMarks,
    teeMarks,
    bankedSoFar: scored,
    rawTotalSoFar,
    rawTotalRequired: RAW_PASS_TOTAL,
    totalIfTeeClearedAtMinimum,
    canPass,
    blockers,
    advisories,
    teeRequirement,
    explanation,
  };
}

// --- attendance runway -----------------------------------------------------

export interface AttendanceRunway {
  percent: number;
  attended: number;
  total: number;
  /** Instructional (teaching) days between now and the deadline, inclusive. */
  instructionalDays: number;
  /** Sessions of THIS course falling before the deadline. */
  upcomingClasses: number;
  /** Classes that may be skipped and still sit the exam at >= 75%. */
  skippable: number;
  /** Consecutive classes to attend to restore >= 75% by the deadline. */
  mustAttend: number | null;
  /** Attendance percentage at the deadline if every upcoming class is skipped. */
  percentIfSkipAll: number;
  eligibleNow: boolean;
  eligibleAtDeadline: boolean;
}

/**
 * How many of this course's remaining classes can be skipped before the 75%
 * gate is lost at the deadline.
 */
export function attendanceRunway(
  current: { attended: number; total: number },
  upcomingSessions: number,
): AttendanceRunway {
  const { attended, total } = current;
  const u = Math.max(0, upcomingSessions);
  const percent = total > 0 ? round2((attended / total) * 100) : 0;

  const gate = ATTENDANCE_GATE_PERCENT / 100;

  // Attending (u - s) of the upcoming classes:
  //   (a + u - s) / (t + u) >= gate  ->  s <= a + (1 - gate) * u - gate * t
  const skippable = Math.max(
    0,
    Math.floor(attended + (1 - gate) * u - gate * total + 1e-9),
  );

  // Consecutive classes to attend to reach the gate by the deadline:
  //   (a + x) / (t + u) >= gate  ->  x >= gate * (t + u) - a
  const need = gate * (total + u) - attended;
  const mustAttend = need > 0 ? Math.ceil(need - 1e-9) : 0;

  const percentIfSkipAll =
    total + u > 0 ? round2((attended / (total + u)) * 100) : 0;

  return {
    percent,
    attended,
    total,
    instructionalDays: 0, // filled in by the caller from the calendar
    upcomingClasses: u,
    skippable,
    mustAttend: mustAttend > 0 ? mustAttend : null,
    percentIfSkipAll,
    eligibleNow: percent >= ATTENDANCE_GATE_PERCENT,
    eligibleAtDeadline: percentIfSkipAll >= ATTENDANCE_GATE_PERCENT,
  };
}

/**
 * Sessions of one course falling before `deadlineISO`, from the timetable grid
 * crossed with the academic calendar, so holidays and working Saturdays that
 * follow another day's timetable are handled correctly.
 */
export function sessionsBefore(
  courseDays: Weekday[],
  calendar: CalendarDay[],
  todayISO: string,
  deadlineISO: string,
): number {
  if (courseDays.length === 0) return 0;
  const set = new Set(courseDays);
  let count = 0;
  for (const day of calendar) {
    if (!day.instructional) continue;
    if (day.date < todayISO) continue;
    if (day.date > deadlineISO) continue;
    // A calendar entry may override the weekday (a working Saturday running
    // the Thursday timetable), so use the day-order when one is present.
    const weekday = day.dayOrderWeekday ?? null;
    if (weekday && set.has(weekday)) count++;
  }
  return count;
}

/** Instructional (teaching) days in the window, inclusive. */
export function instructionalDaysBetween(
  calendar: CalendarDay[],
  todayISO: string,
  deadlineISO: string,
): number {
  let n = 0;
  for (const day of calendar) {
    if (!day.instructional) continue;
    if (day.date < todayISO) continue;
    if (day.date > deadlineISO) continue;
    n++;
  }
  return n;
}