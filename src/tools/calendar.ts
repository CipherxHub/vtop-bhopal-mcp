import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VtopClient } from "../services/vtop-client.js";
import { weekdayOf, type CalendarDay } from "../services/attendance-calc.js";
import { CalendarSchema } from "../schemas/index.js";
import { mkJsonTool } from "./_helpers.js";

export function registerCalendarTool(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "get_calendar",
    "Look up the academic calendar: holidays, events (e.g. TechnoVIT), working Saturdays / day-orders, and which days are instructional. Use `query` to find a named event/holiday (e.g. 'technovit', 'pongal'), `month` ('YYYY-MM') to list a month, or `holidaysOnly` for just the no-class days; with no filter it returns the semester's notable days (holidays + working-Saturday day-orders). Festivals/holidays belong to the term they fall in, so if a `query` finds nothing, call get_semesters and retry with that semester's id. If the response contains NOT_AUTHENTICATED, call get_captcha then login then retry. Requires login.",
    CalendarSchema.shape,
    async ({ semesterId, month, query, holidaysOnly }) => {
      const id = semesterId ?? (await client.getCurrentSemesterId());
      let from = "1900-01-01";
      let to = "2999-12-31";
      if (month && /^\d{4}-\d{2}$/.test(month)) {
        from = `${month}-01`;
        to = `${month}-31`;
      }
      const days = await client.getCalendar(id, from, to);

      const isNotable = (d: CalendarDay) =>
        !d.instructional || !!d.dayOrderWeekday || (!!d.label && !/^working day$/i.test(d.label));

      let result: CalendarDay[];
      if (query) {
        const q = query.toLowerCase();
        result = days.filter((d) => (d.label ?? "").toLowerCase().includes(q));
      } else if (holidaysOnly) {
        result = days.filter((d) => !d.instructional);
      } else if (month) {
        result = days;
      } else {
        result = days.filter(isNotable);
      }

      const view = result.map((d) => ({
        date: d.date,
        weekday: weekdayOf(d.date),
        instructional: d.instructional,
        dayOrder: d.dayOrderWeekday,
        label: d.label ?? "",
      }));

      return {
        semesterId: id,
        ...(query ? { query } : {}),
        count: view.length,
        ...(query && view.length === 0
          ? {
              message: `No calendar entry matching "${query}" in this semester. Festivals/holidays appear in the term they fall in — try get_semesters and pass another semester's id.`,
            }
          : {}),
        days: view,
      };
    },
  );
}
