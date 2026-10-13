/**
 * Pure attendance math — no network, no parsing, fully unit-testable.
 *
 * Two layers:
 *  - count-only: from attended/total alone, how many future classes you can
 *    still skip ("bunk buffer") or must attend to recover.
 *  - date-aware: given the weekly schedule + the academic calendar, how many
 *    sessions of a course fall before an attendance-closing date, and what that
 *    means for staying safe.
 */
import type { AttendanceRecord } from "../types/index.js";

/**
 * You're allowed (not debarred) only when attendance is STRICTLY ABOVE this
 * percentage: 74.0% exactly is debarred, 74.001% is allowed. So all comparisons
 * use `>` (not `>=`). Callers can override via targetPercent.
 * This is a percentage in 0..100.
 */
export const SAFE_THRESHOLD_PERCENT = 74.0;

export type Weekday = "SUN" | "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT";
const WEEKDAYS: Weekday[] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** courseCode listed once per weekly session on that weekday (repeats = multiple sessions). */
export type WeeklySchedule = Record<Weekday, string[]>;

export interface CalendarDay {
  /** ISO date, YYYY-MM-DD. */
  date: string;
  /** True when classes are held (an "Instructional Day"). */
  instructional: boolean;
  /** Which weekday's timetable this date follows (e.g. a Saturday running "MON"). */
  dayOrderWeekday: Weekday | null;
  /** Event / holiday / note text for the day (e.g. "TechnoVIT", "Working Day"). */
  label?: string;
}

export interface UpcomingClassDay {
  date: string;
  dayOrderWeekday: Weekday;
  /** Course codes meeting on this date (one entry per session). */
  courses: string[];
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Weekday of an ISO date, computed in UTC to avoid timezone drift. */
export function weekdayOf(isoDate: string): Weekday {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return WEEKDAYS[d.getUTCDay()];
}

/** Current percentage from raw counts (0 when no classes yet). */
export function percentOf(attended: number, total: number): number {
  return total > 0 ? round2((attended / total) * 100) : 0;
}

export function isSafe(
  attended: number,
  total: number,
  targetPercent: number = SAFE_THRESHOLD_PERCENT,
): boolean {
  if (total <= 0) return false;
  return attended / total > targetPercent / 100;
}

/**
 * Largest number of future classes you can skip and stay STRICTLY above the
 * threshold. Each skip adds 1 to total and 0 to attended. 0 if already debarred.
 * Need attended/(total+s) > t  ->  s < attended/t - total.
 */
export function bunkBuffer(
  attended: number,
  total: number,
  targetPercent: number = SAFE_THRESHOLD_PERCENT,
): number {
  const t = targetPercent / 100;
  if (t <= 0) return Number.MAX_SAFE_INTEGER;
  if (!isSafe(attended, total, targetPercent)) return 0;
  return Math.max(0, Math.ceil(attended / t - total - 1e-9) - 1);
}

/**
 * Smallest number of consecutive future classes you must attend to get STRICTLY
 * above the threshold. 0 if already safe; null if unreachable (target >= 100%).
 * Need (attended+x)/(total+x) > t  ->  x > (t*total - attended)/(1-t).
 */
export function classesToRecover(
  attended: number,
  total: number,
  targetPercent: number = SAFE_THRESHOLD_PERCENT,
): number | null {
  const t = targetPercent / 100;
  if (isSafe(attended, total, targetPercent)) return 0;
  if (t >= 1) return null;
  const x = Math.floor((t * total - attended) / (1 - t) + 1e-9) + 1;
  return Math.max(1, x);
}

export interface AttendanceProjection {
  courseCode: string;
  courseName: string;
  courseType: string;
  slot: string;
  attended: number;
  total: number;
  currentPercent: number;
  thresholdPercent: number;
  isSafe: boolean;
  /** Future classes skippable while staying safe (0 if already below). */
  bunkBuffer: number;
  /** Consecutive classes to attend to recover (0 if safe, null if impossible). */
  classesToRecover: number | null;
  advice: string;
  /** Date-aware fields, only present when an until-date projection was requested. */
  deadline?: DeadlineProjection;
  /** "If I skip these specific days and attend everything else" — only when bunkDates given. */
  plannedBunk?: BunkScenario;
}

export interface BunkScenario {
  /** Sessions of this course that fall on the planned bunk dates. */
  bunkedSessions: number;
  /** Final % if you skip exactly those sessions and attend all other upcoming ones. */
  finalPercentIfAttendRest: number;
  /** True if that final % is still above the threshold (i.e. recoverable after the bunk). */
  safe: boolean;
}

/**
 * Scenario math: skip `bunked` of the `upcoming` sessions (the planned days) and
 * attend the rest. finalAttended = a + (u - bunked), finalTotal = n + u.
 */
export function planBunk(
  attended: number,
  total: number,
  upcoming: number,
  bunked: number,
  targetPercent: number = SAFE_THRESHOLD_PERCENT,
): BunkScenario {
  const u = Math.max(0, upcoming);
  const b = Math.min(u, Math.max(0, bunked));
  const finalTotal = total + u;
  const frac = finalTotal > 0 ? (attended + (u - b)) / finalTotal : 0;
  return {
    bunkedSessions: b,
    finalPercentIfAttendRest: round2(frac * 100),
    safe: frac > targetPercent / 100,
  };
}

export interface DeadlineProjection {
  /** Attendance-closing date the projection ran to (ISO). */
  untilDate: string;
  /** Sessions of this course between now and the closing date. */
  upcomingSessions: number;
  /** Final % if you attend every upcoming session. */
  ifAttendAllPercent: number;
  /** Final % if you skip every upcoming session. */
  ifSkipAllPercent: number;
  /** How many of the upcoming sessions you can miss and still end >= threshold. */
  maxSkippableInRange: number;
  /** Minimum upcoming sessions to attend to end >= threshold; null if even attending all falls short. */
  mustAttendInRange: number | null;
  /** True if attending all upcoming sessions reaches the threshold by the deadline. */
  canBeSafeByDeadline: boolean;
}

function adviceFor(
  safe: boolean,
  buffer: number,
  recover: number | null,
): string {
  if (safe) {
    return buffer > 0
      ? `Safe — you can skip up to ${buffer} more class${buffer === 1 ? "" : "es"}.`
      : "Safe, but right at the line — don't skip any more.";
  }
  if (recover === null) return "Below the requirement and cannot be recovered by attending alone.";
  return `Below the requirement — attend the next ${recover} class${recover === 1 ? "" : "es"} to recover.`;
}

/** Count-only projection for one course. */
export function projectCourse(
  rec: AttendanceRecord,
  targetPercent: number = SAFE_THRESHOLD_PERCENT,
): AttendanceProjection {
  const base = {
    courseCode: rec.courseCode,
    courseName: rec.courseName,
    courseType: rec.courseType,
    slot: rec.slot,
    attended: rec.attended,
    total: rec.total,
    thresholdPercent: targetPercent,
  };
  if (rec.total === 0) {
    return {
      ...base,
      currentPercent: 0,
      isSafe: false,
      bunkBuffer: 0,
      classesToRecover: null,
      advice: "No classes conducted yet — nothing to calculate.",
    };
  }
  const safe = isSafe(rec.attended, rec.total, targetPercent);
  const buffer = bunkBuffer(rec.attended, rec.total, targetPercent);
  const recover = classesToRecover(rec.attended, rec.total, targetPercent);
  return {
    ...base,
    currentPercent: percentOf(rec.attended, rec.total),
    isSafe: safe,
    bunkBuffer: buffer,
    classesToRecover: recover,
    advice: adviceFor(safe, buffer, recover),
  };
}

export function projectAll(
  records: AttendanceRecord[],
  targetPercent: number = SAFE_THRESHOLD_PERCENT,
): AttendanceProjection[] {
  return records.map((r) => projectCourse(r, targetPercent));
}

/**
 * Walk the calendar between two dates and list, per instructional day, which
 * courses meet (resolved through the day-order override, e.g. a working Saturday
 * that follows the Monday timetable).
 */
export function listUpcomingClassDays(
  schedule: WeeklySchedule,
  calendar: CalendarDay[],
  fromISO: string,
  toISO: string,
  includeTo: boolean = true,
): UpcomingClassDay[] {
  const out: UpcomingClassDay[] = [];
  for (const day of calendar) {
    if (!day.instructional) continue;
    if (day.date < fromISO) continue;
    if (day.date > toISO) continue;
    if (!includeTo && day.date === toISO) continue;
    const weekday = day.dayOrderWeekday ?? weekdayOf(day.date);
    const courses = schedule[weekday] ?? [];
    if (courses.length > 0) out.push({ date: day.date, dayOrderWeekday: weekday, courses: [...courses] });
  }
  return out;
}

/** Tally upcoming sessions per course code from the day list. */
export function countUpcoming(days: UpcomingClassDay[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const d of days) {
    for (const code of d.courses) counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

/** Date-aware projection for one course given its upcoming session count. */
export function projectDeadline(
  attended: number,
  total: number,
  upcomingSessions: number,
  untilDate: string,
  targetPercent: number = SAFE_THRESHOLD_PERCENT,
): DeadlineProjection {
  const t = targetPercent / 100;
  const u = Math.max(0, upcomingSessions);
  const finalTotal = total + u;
  const ifAttendAll = finalTotal > 0 ? (attended + u) / finalTotal : 0;
  const ifSkipAll = finalTotal > 0 ? attended / finalTotal : 0;
  // skip s, attend (u-s): (attended+u-s)/finalTotal > t  ->  s < attended+u - t*finalTotal
  const maxSkippable = Math.max(0, Math.min(u, Math.ceil(attended + u - t * finalTotal - 1e-9) - 1));
  const canBeSafe = ifAttendAll > t;
  return {
    untilDate,
    upcomingSessions: u,
    ifAttendAllPercent: round2(ifAttendAll * 100),
    ifSkipAllPercent: round2(ifSkipAll * 100),
    maxSkippableInRange: maxSkippable,
    mustAttendInRange: canBeSafe ? u - maxSkippable : null,
    canBeSafeByDeadline: canBeSafe,
  };
}
