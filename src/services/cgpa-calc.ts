/**
 * Degree-completion maths: what a student must score in the courses they
 * have left to hit a target CGPA, and what a given set of grades does to the
 * number they have today.
 *
 * This is a REQUIREMENT calculation, not a prediction: it says "with these
 * credits still to earn, an average of X grade points lands you on Y", using
 * VIT's own published grade-point scale. It never says what grade you will
 * get.
 *
 * The CGPA model, as VTOP reports it:
 *   - grade points: S=10, A=9, B=8, C=7, D=6, E=5, F=0, N=0
 *   - P (pass in a non-credit course) carries no grade points and its credits
 *     do not enter the GPA denominator
 *   - a course you FAILED keeps its credits in the denominator with zero
 *     points, and VIT makes you re-register the course — so the denominator
 *     grows again when you do
 *   - CGPA = total credit points / total graded credits
 */

import { GRADE_POINTS, type GradeLetter } from "./constants.js";

/** A letter and what it is worth. Ordered best to worst. */
export const GRADE_SCALE: { grade: GradeLetter; points: number }[] = [
  { grade: "S", points: GRADE_POINTS.S },
  { grade: "A", points: GRADE_POINTS.A },
  { grade: "B", points: GRADE_POINTS.B },
  { grade: "C", points: GRADE_POINTS.C },
  { grade: "D", points: GRADE_POINTS.D },
  { grade: "E", points: GRADE_POINTS.E },
  { grade: "F", points: GRADE_POINTS.F },
];

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** One course still to be completed. */
export interface RemainingCourse {
  courseCode: string;
  courseName: string;
  /** Credits the course carries — the weight of its grade in the CGPA. */
  credits: number;
  /** Which curriculum basket it belongs to. */
  category?: string;
}

export interface CgpaState {
  /** Graded credits already on record (P courses excluded). */
  gradedCredits: number;
  /** Credit points already banked (sum of gradePoints x credits). */
  creditPoints: number;
  /** CGPA as VTOP reports it. */
  cgpa: number;
  /** Credits earned (passed) so far. */
  creditsEarned: number;
}

/** Rebuild the CGPA state from grade history. */
export function cgpaStateFrom(
  courses: { grade: string; gradePoints: number; credits: number }[],
  reportedCgpa: number | null,
  creditsEarned: number,
): CgpaState {
  let gradedCredits = 0;
  let creditPoints = 0;
  for (const c of courses) {
    // P is a pass in a non-credit course: no points, no denominator.
    if (!c.grade || c.grade === "P") continue;
    gradedCredits += c.credits;
    creditPoints += c.gradePoints * c.credits;
  }
  const computed = gradedCredits > 0 ? creditPoints / gradedCredits : 0;
  return {
    gradedCredits,
    creditPoints,
    // Prefer VTOP's own number; fall back to ours when it is missing.
    cgpa: reportedCgpa ?? round2(computed),
    creditsEarned,
  };
}

/** CGPA after adding `remaining` graded with the given points per credit. */
export function cgpaAfter(
  state: CgpaState,
  remaining: RemainingCourse[],
  pointsPerCourse: (course: RemainingCourse) => number,
): number {
  const credits = remaining.reduce((s, c) => s + c.credits, 0);
  const points = remaining.reduce((s, c) => s + pointsPerCourse(c) * c.credits, 0);
  const totalCredits = state.gradedCredits + credits;
  if (totalCredits <= 0) return 0;
  return round2((state.creditPoints + points) / totalCredits);
}

/** Highest CGPA reachable if every remaining course scores S. */
export function maxCgpa(state: CgpaState, remaining: RemainingCourse[]): number {
  return cgpaAfter(state, remaining, () => GRADE_POINTS.S);
}

/** Lowest CGPA if every remaining course scores F (the course is re-registered). */
export function minCgpa(state: CgpaState, remaining: RemainingCourse[]): number {
  return cgpaAfter(state, remaining, () => GRADE_POINTS.F);
}

export interface TargetAnalysis {
  currentCgpa: number;
  targetCgpa: number;
  /** True when the target is already met and cannot be lost by the rest. */
  alreadyMet: boolean;
  /** True when even all-S cannot reach the target. */
  unreachable: boolean;
  /** Average grade points needed across the remaining credits (null when unreachable). */
  requiredAveragePoints: number | null;
  /** The letter band that average corresponds to, when it falls on a scale point. */
  requiredAverageGrade: GradeLetter | null;
  /** A concrete mix of grades that reaches the target, best-first. */
  mix: { grade: GradeLetter; count: number; credits: number }[] | null;
  /** The same mix with every course at its best grade, for comparison. */
  maxCgpa: number;
  /** CGPA if the remaining courses all fail and are re-registered. */
  minCgpa: number;
  /** Credits the mix is spread over. */
  remainingCredits: number;
  /** Courses in the mix, with the grade each would need. */
  perCourse: { courseCode: string; courseName: string; credits: number; grade: GradeLetter }[];
}

/**
 * What must the remaining courses score to reach `target`?
 *
 * The mix is built by starting from the best grade everywhere and lowering
 * the weakest courses one band at a time — that yields the "6 A's and 2 B's"
 * shape a student actually needs, rather than a single average they would
 * have to hit uniformly.
 */
export function analyseTarget(
  state: CgpaState,
  remaining: RemainingCourse[],
  target: number,
): TargetAnalysis {
  const remainingCredits = remaining.reduce((s, c) => s + c.credits, 0);
  const max = maxCgpa(state, remaining);
  const min = minCgpa(state, remaining);

  const base = {
    currentCgpa: state.cgpa,
    targetCgpa: target,
    remainingCredits,
    maxCgpa: max,
    minCgpa: min,
  };

  if (remaining.length === 0 || remainingCredits <= 0) {
    return {
      ...base,
      alreadyMet: state.cgpa >= target,
      unreachable: state.cgpa < target,
      requiredAveragePoints: null,
      requiredAverageGrade: null,
      mix: null,
      perCourse: [],
    };
  }

  if (state.cgpa >= target) {
    // Already there: report the best case and how much room there is.
    return {
      ...base,
      alreadyMet: true,
      unreachable: false,
      requiredAveragePoints: 0,
      requiredAverageGrade: "F",
      mix: null,
      perCourse: [],
    };
  }

  if (max < target) {
    return {
      ...base,
      alreadyMet: false,
      unreachable: true,
      requiredAveragePoints: null,
      requiredAverageGrade: null,
      mix: null,
      perCourse: [],
    };
  }

  // Required average grade points over the remaining credits:
  //   (S + g*Cr) / (C + Cr) >= target   ->   g >= target - (S - target*C)/Cr
  const required =
    target - (state.creditPoints - target * state.gradedCredits) / remainingCredits;

  // The mix: split the remaining credits across the two grade bands that
  // bracket the required average, so the answer reads like "2 S and 2 A"
  // rather than an average nobody can hit course by course.
  const upper = GRADE_SCALE.find((g) => g.points + 1e-9 >= required) ?? GRADE_SCALE[0];
  const lower =
    GRADE_SCALE.find((g) => g.points <= upper.points - 1e-9) ??
    GRADE_SCALE[GRADE_SCALE.length - 1];
  const span = upper.points - lower.points;
  // Fraction of the remaining credits that must sit at the upper band.
  const upperCredits =
    span > 0 ? ((required - lower.points) / span) * remainingCredits : remainingCredits;

  const ordered = [...remaining].sort((a, b) => b.credits - a.credits);
  const perCourse: { course: RemainingCourse; points: number }[] = [];
  let budget = upperCredits;
  for (const c of ordered) {
    const points = c.credits <= budget ? upper.points : lower.points;
    if (points === upper.points) budget -= c.credits;
    perCourse.push({ course: c, points });
  }
  // Whole courses only: the split may leave a course just over the line, and
  // the answer must still reach the target.
  const projected = (): number => {
    const credits = perCourse.reduce((s, c) => s + c.course.credits, 0);
    const points = perCourse.reduce((s, c) => s + c.points * c.course.credits, 0);
    return round2((state.creditPoints + points) / (state.gradedCredits + credits));
  };
  for (const entry of [...perCourse].sort((a, b) => a.course.credits - b.course.credits)) {
    if (projected() >= target) break;
    if (entry.points < upper.points) entry.points = upper.points;
  }

  const mixCounts = new Map<GradeLetter, { count: number; credits: number }>();
  for (const entry of perCourse) {
    const letter = GRADE_SCALE.find((g) => g.points === entry.points)?.grade ?? "F";
    const agg = mixCounts.get(letter) ?? { count: 0, credits: 0 };
    agg.count += 1;
    agg.credits += entry.course.credits;
    mixCounts.set(letter, agg);
  }
  const mix = GRADE_SCALE.filter((g) => mixCounts.has(g.grade)).map((g) => ({
    grade: g.grade,
    count: mixCounts.get(g.grade)!.count,
    credits: mixCounts.get(g.grade)!.credits,
  }));

  const requiredAverageGrade =
    GRADE_SCALE.find((g) => Math.abs(g.points - required) < 0.01)?.grade ?? null;

  return {
    ...base,
    alreadyMet: false,
    unreachable: false,
    requiredAveragePoints: round2(required),
    requiredAverageGrade,
    mix,
    perCourse: perCourse.map((e) => ({
      courseCode: e.course.courseCode,
      courseName: e.course.courseName,
      credits: e.course.credits,
      grade: GRADE_SCALE.find((g) => g.points === e.points)?.grade ?? "F",
    })),
  };
}

/**
 * What each failed course costs, and what passing it would buy.
 *
 * VIT makes a failed course be re-registered, so passing it later ADDS its
 * credits to the denominator again as well as its points. That is why
 * "improve your CGPA" and "clear the backlog" pull in opposite directions,
 * and the numbers below show both.
 */
export interface FailedCourseImpact {
  courseCode: string;
  courseName: string;
  credits: number;
  /** Points the course contributes now: zero. */
  currentPoints: number;
  /** CGPA today. */
  currentCgpa: number;
  /** CGPA if the course were simply not on the record (credits and points gone). */
  cgpaWithoutCourse: number;
  /**
   * CGPA if the course is re-registered and passed at the lowest passing
   * grade (D = 6). The credits come back into the denominator too, which is
   * why this can be LOWER than the current CGPA.
   */
  cgpaIfRepassedAtD: number;
  /** Points the student gains by clearing it (negative means the extra credits cost more). */
  gainIfRepassed: number;
  /** Pass grade that would be needed for the re-registration to improve the CGPA. */
  passGradeThatHelps: GradeLetter | null;
}

/** A failed course in the grade history. */
export interface FailedCourse {
  courseCode: string;
  courseName: string;
  credits: number;
}

/**
 * The cost of each failed course, and the effect of clearing it.
 */
export function failedCourseImpacts(
  state: CgpaState,
  failed: FailedCourse[],
  existingCredits: number,
): FailedCourseImpact[] {
  return failed.map((f) => {
    const without = state.gradedCredits - f.credits;
    const pointsWithout = state.creditPoints;
    const cgpaWithoutCourse =
      without > 0 ? round2(pointsWithout / without) : state.cgpa;

    // Re-registered and passed at D: the credits come back (denominator
    // grows) and the points arrive.
    const repassedCredits = state.gradedCredits + f.credits;
    const repassedPoints = state.creditPoints + GRADE_POINTS.D * f.credits;
    const cgpaIfRepassedAtD =
      repassedCredits > 0 ? round2(repassedPoints / repassedCredits) : state.cgpa;

    // Which grade would make re-registering actually help? The LOWEST grade
    // that clears the bar — that is the actionable answer ("an A here
    // improves your CGPA, a D does not"), not the best one available.
    let passGradeThatHelps: GradeLetter | null = null;
    const ascending = [...GRADE_SCALE].reverse(); // F .. S
    for (const g of ascending) {
      if (g.points < GRADE_POINTS.D) continue; // below D is not a pass
      const pts = state.creditPoints + g.points * f.credits;
      const cgpa = repassedCredits > 0 ? round2(pts / repassedCredits) : 0;
      if (cgpa > state.cgpa) {
        passGradeThatHelps = g.grade;
        break;
      }
    }

    return {
      courseCode: f.courseCode,
      courseName: f.courseName,
      credits: f.credits,
      currentPoints: 0,
      currentCgpa: state.cgpa,
      cgpaWithoutCourse,
      cgpaIfRepassedAtD,
      gainIfRepassed: round2(cgpaIfRepassedAtD - state.cgpa),
      passGradeThatHelps,
      ...(existingCredits ? {} : {}),
    };
  });
}

export interface DeltaAnalysis {
  currentCgpa: number;
  /** CGPA if the remaining courses score as given. */
  projectedCgpa: number;
  /** projectedCgpa - currentCgpa (rounded to 2 dp). */
  change: number;
  /** The grades applied, course by course. */
  applied: { courseCode: string; courseName: string; credits: number; grade: GradeLetter }[];
  /** CGPA if every one of those courses scored S instead. */
  ifAllS: number;
  /** CGPA if every one of those courses scored F instead. */
  ifAllF: number;
}

/**
 * What does this set of grades do to the CGPA? `grades` maps a course code
 * to the letter it will score; courses not mentioned are left out of the
 * projection (they still have to be completed, but their grade is unknown).
 */
export function analyseDelta(
  state: CgpaState,
  remaining: RemainingCourse[],
  grades: Record<string, GradeLetter>,
): DeltaAnalysis {
  const applied = remaining
    .filter((c) => grades[c.courseCode])
    .map((c) => ({
      courseCode: c.courseCode,
      courseName: c.courseName,
      credits: c.credits,
      grade: grades[c.courseCode],
    }));
  const pointsFor = (course: RemainingCourse): number => {
    const letter = grades[course.courseCode];
    if (!letter) return 0; // unknown grade: contributes nothing to the estimate
    return GRADE_POINTS[letter] ?? 0;
  };
  const projected = cgpaAfter(state, applied, pointsFor);
  return {
    currentCgpa: state.cgpa,
    projectedCgpa: projected,
    change: round2(projected - state.cgpa),
    applied,
    ifAllS: cgpaAfter(state, applied, () => GRADE_POINTS.S),
    ifAllF: cgpaAfter(state, applied, () => GRADE_POINTS.F),
  };
}
