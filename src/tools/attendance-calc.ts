import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VtopClient } from "../services/vtop-client.js";
import { parseAttendance, parseTimetableGrid, weeklyScheduleFromGrid } from "../services/vtop-parser.js";
import {
  SAFE_THRESHOLD_PERCENT,
  projectAll,
  projectDeadline,
  planBunk,
  listUpcomingClassDays,
  countUpcoming,
} from "../services/attendance-calc.js";
import { assertIsoDate } from "../services/dates.js";
import { CalcAttendanceSchema } from "../schemas/index.js";
import { termBounds } from "./calendar.js";
import { mkJsonTool } from "./_helpers.js";

/** Today's date in IST (VIT is UTC+5:30), as ISO YYYY-MM-DD. */
function istToday(): string {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

export function registerAttendanceCalcTool(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "calculate_attendance",
    "Attendance / bunk calculator. Per course: current %, whether you're safe (strictly above 74.0% by default — 74.0 is debarred; override via targetPercent), how many more classes you can skip ('bunkBuffer'), and how many to attend to recover ('classesToRecover'). " +
      "For the key real use case — 'I'm at the line; if I skip today can I still make 75% by the time attendance closes?' — pass `untilDate` (the attendance-closing date; ASK THE USER for it) or `toTermEnd: true` to project to the last instructional day of the term automatically, plus `bunkDates` (the days you'd skip, e.g. today's date). Using the timetable + academic calendar (holidays, working Saturdays / day-orders) it returns per course: `upcomingSessions` until the deadline, `ifAttendAllPercent`/`ifSkipAllPercent`, `maxSkippableInRange`, `mustAttendInRange`, `canBeSafeByDeadline`, and — when `bunkDates` is given — `plannedBunk` (your final % and whether you're still safe if you skip exactly those days and attend everything else). Also returns a `perDay` breakdown of which classes fall on each upcoming day. " +
      "If the response contains NOT_AUTHENTICATED, call get_captcha then login then retry. login auto-uses VTOP_USERNAME/VTOP_PASSWORD env vars if set; if it reports credentials missing, ask the user for them. Requires login.",
    CalcAttendanceSchema.shape,
    async ({ semesterId, courseCode, targetPercent, untilDate, includeUntilDate, bunkDates, toTermEnd }) => {
      // Malformed dates corrupt the month slicing and read as "no classes".
      // A past untilDate is legitimate (closed window: zero sessions left).
      assertIsoDate(untilDate, "untilDate");
      for (const d of bunkDates ?? []) assertIsoDate(d, "bunkDates entry");
      const id = semesterId ?? (await client.getCurrentSemesterId());
      const attHtml = await client.getAttendanceHtml(id);
      let records = parseAttendance(attHtml);

      const wanted = courseCode?.trim().toLowerCase();
      if (wanted) {
        records = records.filter((r) => r.courseCode.toLowerCase() === wanted);
        if (records.length === 0) {
          throw new Error(`No attendance record for course "${courseCode}" in this semester.`);
        }
      }

      const threshold = targetPercent ?? SAFE_THRESHOLD_PERCENT;
      const courses = projectAll(records, threshold);
      const from = istToday();

      // Term-aware projection: resolve the closing date to the last
      // instructional day so holidays, working Saturdays and day-orders fall
      // out of the calendar instead of being guessed.
      let closeDate = untilDate ?? null;
      let bounds: Awaited<ReturnType<typeof termBounds>> | null = null;
      if (toTermEnd && !closeDate) {
        bounds = await termBounds(client, id, from);
        if (bounds.teachingOver) {
          return {
            thresholdPercent: threshold,
            overallSafe: courses.every((c) => c.isSafe),
            courses,
            termBounds: bounds,
            verdict:
              "Teaching is over for this term: no more classes can occur, so these figures are final (locked). Nothing left to attend or skip.",
          };
        }
        closeDate = bounds.lastInstructionalDay;
      }

      if (!closeDate) {
        return {
          thresholdPercent: threshold,
          overallSafe: courses.every((c) => c.isSafe),
          courses,
        };
      }
      const gridHtml = await client.getTimetableHtml(id);
      const schedule = weeklyScheduleFromGrid(parseTimetableGrid(gridHtml));
      const calendar = await client.getCalendar(id, from, closeDate);
      const days = listUpcomingClassDays(schedule, calendar, from, closeDate, includeUntilDate ?? true);
      const counts = countUpcoming(days);

      // Sessions on the specific days the user plans to skip.
      const bunkSet = new Set(bunkDates ?? []);
      const bunkedCounts = bunkSet.size > 0 ? countUpcoming(days.filter((d) => bunkSet.has(d.date))) : {};

      for (const c of courses) {
        const u = counts[c.courseCode] ?? 0;
        // Date-aware math needs real counts; unknown figures stay without a
        // deadline projection rather than projecting from fabricated zeros.
        if (c.attended !== null && c.total !== null) {
          c.deadline = projectDeadline(c.attended, c.total, u, closeDate, threshold);
          if (bunkSet.size > 0) {
            c.plannedBunk = planBunk(c.attended, c.total, u, bunkedCounts[c.courseCode] ?? 0, threshold);
          }
        }
      }

      const perDay = days
        .map((d) => ({
          date: d.date,
          dayOrder: d.dayOrderWeekday,
          courses: wanted ? d.courses.filter((cc) => cc.toLowerCase() === wanted) : d.courses,
        }))
        .filter((d) => d.courses.length > 0);

      return {
        thresholdPercent: threshold,
        untilDate: closeDate,
        ...(toTermEnd && !untilDate ? { resolvedToTermEnd: true } : {}),
        from,
        ...(bunkSet.size > 0 ? { bunkDates: [...bunkSet] } : {}),
        overallSafe: courses.every((c) => c.isSafe),
        courses,
        perDay,
      };
    },
    { emptyMessage: "No attendance records found. The semester may not have started yet." },
  );
}
