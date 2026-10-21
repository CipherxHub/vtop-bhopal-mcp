/**
 * Attendance cross-check: does VTOP's own "total classes" figure match the
 * sessions the timetable and the academic calendar imply?
 *
 * Why this exists: every projection we make (remaining classes, how many
 * you may skip, whether attendance is locked) is derived from the calendar
 * and the timetable, while the attended/total numbers come from VTOP's
 * attendance page. If those two disagree, the projections and the headline
 * percentage describe different worlds. Nothing in the tool set noticed that
 * before; this does.
 *
 * The difference is reported, never "fixed": VTOP counts classes its own way
 * (a cancelled session, a lab that started late, a class a faculty member
 * added to the calendar), and a difference is information for the student,
 * not a bug in this server.
 */

import {
  countUpcoming,
  listUpcomingClassDays,
  type CalendarDay,
  type WeeklySchedule,
} from "./attendance-calc.js";
import { weeklyScheduleFromGrid } from "./vtop-parser.js";
import type { AttendanceRecord } from "../types/index.js";

const round2 = (x: number): number => Math.round(x * 100) / 100;

export interface CourseTotalCheck {
  courseCode: string;
  courseName: string;
  /** VTOP's own "total classes" for the course. */
  vtopTotal: number | null;
  /** Sessions the timetable x calendar imply for the term. */
  expectedSessions: number;
  /** expectedSessions - vtopTotal (null when VTOP published no total). */
  difference: number | null;
  /** True when the two agree. */
  matches: boolean;
  /** Why a difference is expected to be there, when we can tell. */
  note: string | null;
}

/**
 * Compare VTOP's attendance totals with the sessions the timetable and the
 * academic calendar imply.
 *
 * `schedule` is the weekly timetable (weekday -> course codes) and `calendar`
 * the term's days. Only courses that appear in BOTH are checked: a course in
 * the attendance page but not in the current timetable (a finished course)
 * has no expected count to compare against.
 */
export function checkAttendanceTotals(
  records: AttendanceRecord[],
  schedule: WeeklySchedule,
  calendar: CalendarDay[],
): CourseTotalCheck[] {
  // Sessions the calendar implies, per course, over the whole term.
  const instructional = calendar.filter((d) => d.instructional);
  const first = instructional.map((d) => d.date).sort()[0] ?? null;
  const last = instructional.map((d) => d.date).sort().slice(-1)[0] ?? null;
  const expected = new Map<string, number>();
  if (first && last) {
    const days = listUpcomingClassDays(schedule, calendar, first, last, true);
    for (const [code, n] of Object.entries(countUpcoming(days))) {
      expected.set(code, n);
    }
  }

  const out: CourseTotalCheck[] = [];
  for (const r of records) {
    const code = r.courseCode.toUpperCase();
    const expectedSessions = expected.get(code) ?? expected.get(r.courseCode) ?? 0;
    const vtopTotal = r.total;
    const difference =
      vtopTotal === null ? null : expectedSessions - vtopTotal;
    out.push({
      courseCode: r.courseCode,
      courseName: r.courseName,
      vtopTotal,
      expectedSessions,
      difference,
      matches: difference === 0,
      note: noteFor(difference),
    });
  }
  return out;
}

function noteFor(difference: number | null): string | null {
  if (difference === null) return "VTOP published no total for this course.";
  if (difference === 0) return null;
  if (difference > 0) {
    return (
      `The timetable and calendar imply ${difference} more session(s) than VTOP counts. ` +
      "Usual causes: a session VTOP did not count, a class added to the calendar, or a " +
      "day-order override. Check the per-day detail before acting on it."
    );
  }
  return (
    `VTOP counts ${Math.abs(difference)} more session(s) than the timetable and calendar imply. ` +
    "Usual causes: a cancelled session VTOP still counts, or a class that is not on " +
    "the weekly grid (a make-up class). Check the per-day detail before acting on it."
  );
}

/** How many sessions a course has per instructional day, on average. */
export function expectedPerWeek(
  schedule: WeeklySchedule,
  courseCode: string,
): number {
  return Object.values(schedule).filter((codes) =>
    codes.some((c) => c.toUpperCase() === courseCode.toUpperCase()),
  ).length;
}

/** Build the weekly schedule from a parsed timetable grid. */
export function scheduleFromGrid(sessions: { day: string; courseCode: string }[]): WeeklySchedule {
  return weeklyScheduleFromGrid(
    sessions as Parameters<typeof weeklyScheduleFromGrid>[0],
  );
}

export { round2 };
