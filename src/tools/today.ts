import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VtopClient } from "../services/vtop-client.js";
import { parseTimetable, parseTimetableGrid } from "../services/vtop-parser.js";
import { weekdayOf } from "../services/attendance-calc.js";
import { assertIsoDate } from "../services/dates.js";
import { TodayClassesSchema } from "../schemas/index.js";
import { mkJsonTool } from "./_helpers.js";

function istToday(): string {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

export function registerTodayClassesTool(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "get_today_classes",
    "List the classes scheduled for today (or a given date) with their time and venue, accounting for the academic calendar — returns a holiday/no-class result on non-instructional days, and follows the correct day-order on working Saturdays (e.g. a Saturday running the Thursday timetable). Pass `date` (ISO YYYY-MM-DD) to check another day. If the response contains NOT_AUTHENTICATED, call get_captcha then login then retry. Requires login.",
    TodayClassesSchema.shape,
    async ({ date }) => {
      // Garbage dates used to flow into string-compared calendar math and
      // read as "no classes". Reject them at the boundary instead.
      assertIsoDate(date, "date");
      const target = date ?? istToday();
      const id = await client.getCurrentSemesterId();

      const gridHtml = await client.getTimetableHtml(id);
      const sessions = parseTimetableGrid(gridHtml);
      // Course names are auxiliary: the grid is the authority, and a page
      // carrying only the grid must not fail the whole call.
      let names = new Map<string, string>();
      try {
        names = new Map(parseTimetable(gridHtml).map((c) => [c.courseCode, c.courseName]));
      } catch {
        /* names stay empty */
      }

      const calendar = await client.getCalendar(id, target, target);
      const calDay = calendar.find((d) => d.date === target);

      if (!calDay) {
        return { date: target, instructional: false, message: "No calendar entry for this date (outside the semester?).", classes: [] };
      }
      if (!calDay.instructional) {
        // Say WHY there are no classes. "Holiday" is frequently wrong: after
        // the last instructional day almost every remaining day of the term
        // is an examination day, and telling a student their exam day is a
        // holiday is actively misleading. VTOP publishes the reason.
        const why = calDay.label?.trim();
        return {
          date: target,
          instructional: false,
          reason: why || null,
          message: why
            ? `No classes - ${why}.`
            : "No classes - non-instructional day.",
          classes: [],
        };
      }

      const weekday = calDay.dayOrderWeekday ?? weekdayOf(target);
      const classes = sessions
        .filter((s) => s.day === weekday)
        .sort((a, b) => a.startTime.localeCompare(b.startTime))
        .map((s) => ({
          courseCode: s.courseCode,
          courseName: names.get(s.courseCode) ?? "",
          slot: s.slot,
          type: s.type,
          startTime: s.startTime,
          endTime: s.endTime,
          venue: s.venue,
        }));

      return { date: target, instructional: true, dayOrderFollowed: weekday, classes };
    },
  );
}
