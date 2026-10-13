import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VtopClient } from "../services/vtop-client.js";
import { parseAttendanceDetailRefs, parseAttendanceDetail } from "../services/vtop-parser.js";
import { pMap } from "../services/concurrency.js";
import { ENDPOINTS, OD_EVENT_LIMIT, OD_RULE_NOTE } from "../services/constants.js";
import { OdCalcSchema } from "../schemas/index.js";
import { mkJsonTool } from "./_helpers.js";

export function registerOdCalcTool(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "calculate_od",
    `Count your On-Duty (OD) days this semester from the per-class attendance detail and check them against VIT Bhopal's event-OD limit (~${OD_EVENT_LIMIT}; DSW-approved ODs don't count but VTOP can't tell them apart, so all are counted). Returns distinct OD days with dates, OD classes per course, days remaining, and whether you're over. Always pass on the returned "note" about the rule being unconfirmed. This reads each course's attendance detail, so it makes several requests. If the response contains NOT_AUTHENTICATED, call get_captcha then login then retry. Requires login.`,
    OdCalcSchema.shape,
    async ({ semesterId, courseCode }) => {
      const id = semesterId ?? (await client.getCurrentSemesterId());
      // Fetching the main attendance page also establishes the page context the
      // detail action needs.
      const mainHtml = await client.fetchPage(ENDPOINTS.attendance, { semesterSubId: id });
      let refs = parseAttendanceDetailRefs(mainHtml);
      const wanted = courseCode?.trim().toLowerCase();
      if (wanted) {
        refs = refs.filter((r) => r.courseCode.toLowerCase() === wanted);
        if (refs.length === 0) throw new Error(`No course "${courseCode}" found in this semester's attendance.`);
      }

      // Fetch each course's per-class detail concurrently (the slow part).
      const perCourse = await pMap(refs, async (ref) => {
        const html = await client.fetchPage(ENDPOINTS.attendanceDetail, {
          semesterSubId: id,
          ...ref.params,
          x: new Date().toUTCString(),
        });
        const d = parseAttendanceDetail(html);
        return {
          courseCode: ref.courseCode,
          courseName: ref.courseName,
          odClasses: d.onDuty,
          odDates: d.odDates,
          present: d.present,
          absent: d.absent,
          total: d.total,
        };
      });

      // An event OD covers every class that day, so count distinct dates.
      const odDays = [...new Set(perCourse.flatMap((c) => c.odDates))].sort(
        (a, b) => a.split("-").reverse().join("-").localeCompare(b.split("-").reverse().join("-")),
      );
      return {
        semesterId: id,
        odDays: odDays.length,
        odDates: odDays,
        odClasses: perCourse.reduce((s, c) => s + c.odClasses, 0),
        eventOdLimit: OD_EVENT_LIMIT,
        remainingOdDays: Math.max(0, OD_EVENT_LIMIT - odDays.length),
        overLimit: odDays.length > OD_EVENT_LIMIT,
        note: OD_RULE_NOTE,
        perCourse,
      };
    },
  );
}
