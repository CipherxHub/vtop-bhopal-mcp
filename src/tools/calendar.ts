import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VtopClient } from "../services/vtop-client.js";
import { weekdayOf, termBounds, type CalendarDay } from "../services/attendance-calc.js";
import { assertIsoMonth } from "../services/dates.js";
import { CalendarSchema, SemesterInputSchema } from "../schemas/index.js";
import { mkJsonTool } from "./_helpers.js";

/** Today in IST, matching the rest of the tools. */
function istToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function registerCalendarTool(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "get_calendar",
    "Look up the academic calendar: holidays, events (e.g. TechnoVIT), working Saturdays / day-orders, and which days are instructional. Use `query` to find a named event/holiday (e.g. 'technovit', 'pongal'), `month` ('YYYY-MM') to list a month, or `holidaysOnly` for just the no-class days; with no filter it returns the semester's notable days (holidays + working-Saturday day-orders). Festivals/holidays belong to the term they fall in, so if a `query` finds nothing, call get_semesters and retry with that semester's id. If the response contains NOT_AUTHENTICATED, call get_captcha then login then retry. Requires login.",
    CalendarSchema.shape,
    async ({ semesterId, month, query, holidaysOnly, classGroup }) => {
      const id = semesterId ?? (await client.getCurrentSemesterId());
      const group = classGroup?.trim() || "COMB";
      // A malformed month used to be silently ignored (returning notable-days
      // instead of the requested month). Fail loud: "2026-13" is never data.
      assertIsoMonth(month, "month");
      let from = "1900-01-01";
      let to = "2999-12-31";
      if (month) {
        from = `${month}-01`;
        const [y, m] = month.split("-").map(Number);
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        to = `${month}-${String(lastDay).padStart(2, "0")}`;
      }
      const days = await client.getCalendar(id, from, to, group);

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
        classGroup: group,
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

export function registerSemesterInfoTool(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "get_semester_info",
    "Term bounds for a semester: id, name, first/last instructional day from the academic calendar, instructional-day totals, days remaining, and whether teaching is over. When teachingOver is true, no more classes can occur — attendance figures are final (locked), not projectable. Use this to answer 'when does my semester end?' or 'how many teaching days are left?'. Requires login.",
    SemesterInputSchema.shape,
    async ({ semesterId }) => {
      const id = semesterId ?? (await client.getCurrentSemesterId());
      const name = (await client.getSemesters()).find((s) => s.id === id)?.name ?? null;
      const today = istToday();
      const bounds = await termBounds(client.getCalendar.bind(client), id, today);
      return {
        semesterId: id,
        name,
        today,
        ...bounds,
        ...(bounds.teachingOver === true
          ? { note: "Teaching is over for this term: attendance figures are final and no further classes can change them." }
          : bounds.teachingOver === false
            ? { note: `${bounds.instructionalDaysRemaining} instructional days remain (including today).` }
            : { note: "Term bounds unreadable from the calendar — neither confirmed nor ruled out." }),
      };
    },
  );
}
