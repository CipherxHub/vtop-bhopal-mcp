import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VtopClient } from "../services/vtop-client.js";
import { parseMarks, parseAttendance } from "../services/vtop-parser.js";
import { ENDPOINTS } from "../services/constants.js";
import {
  summariseInternals,
  attendanceForecast,
  attendanceRuleFor,
} from "../services/marks-calc.js";
import { SemesterInputSchema } from "../schemas/index.js";
import { mkJsonTool } from "./_helpers.js";

export function registerMarksTool(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "get_marks",
    "Get internal marks/assessment scores: per component the raw marks, max marks, weightage (the marks that component contributes to the internal total), max weightage, class average and status. Use get_internal_totals instead when you want the TOTAL for each subject rather than the component breakdown. semesterId is optional; omit for current semester. If the response contains NOT_AUTHENTICATED, follow the error's `recovery` array and retry. Requires login.",
    SemesterInputSchema.shape,
    async ({ semesterId, refresh }) => {
      const id = semesterId ?? (await client.getCurrentSemesterId());
      return parseMarks(await client.getMarksHtml(id, refresh ?? false));
    },
    {
      emptyMessage:
        "No marks records found. Internal assessments may not be published yet for this semester.",
    }
  );

  mkJsonTool(
    server,
    "get_internal_totals",
    "TOTAL internal marks for every subject, out of the 100-mark course scale (internal assessment 40 = lab/class 35 + attendance 5; CAT-I 15 + CAT-II 15 = 30; Term End Examination 30). ORDER MATTERS when reporting: give every subject with its full component breakdown FIRST, then the totals at the END. For each course: `scoredSoFar` (exact), `percentOfScale`, and `outstanding` - components VTOP has not published yet, since it omits them rather than showing zero. Your marks can only rise. Where the attendance component is still outstanding, `attendanceForecast` projects what your current attendance is worth out of 5 — remember these marks are only awarded after the last instructional day, so it is a projection, not a settled score. `outstanding` means no mark is published yet: usually the faculty has not entered it, which is not the same as the component being unconducted. The letter grade is awarded RELATIVELY against the class average, so the 100 total does not map directly to an S/A/B. semesterId is optional; omit for current semester. Requires login.",
    SemesterInputSchema.shape,
    async ({ semesterId, refresh }) => {
      const id = semesterId ?? (await client.getCurrentSemesterId());

      // Marks and attendance are independent pages, so fetch them together.
      // Sequentially this was marks (614ms) then attendance (760ms) = 1364ms;
      // in parallel it costs only as long as the slower one.
      const [marksHtml, attendanceHtml] = await Promise.all([
        client.getMarksHtml(id, refresh ?? false),
        // Best-effort: if attendance can't be read the totals still stand,
        // just without the attendance forecast.
        client.getAttendanceHtml(id, refresh ?? false).catch(() => null),
      ]);

      const records = parseMarks(marksHtml);
      const summary = summariseInternals(records, id);

      const attendanceByCourse = attendanceHtml
        ? new Map(
            parseAttendance(attendanceHtml).map((a) => [
              a.courseCode.toUpperCase(),
              a.percentage,
            ]),
          )
        : new Map<string, number>();

      const rule = attendanceRuleFor(id, records);
      const courses = records.map((rec, i) => ({
        ...summary.courses[i],
        attendanceForecast: attendanceForecast(
          rec,
          rule,
          attendanceByCourse.get(rec.courseCode.toUpperCase()) ?? null,
        ),
      }));

      // Shape stays courses-first, totals-last.
      const withMarks = new Set(records.map((r) => r.courseCode.toUpperCase()));
      // Courses you are enrolled in and attending but which have no marks page
      // at all. Common and legitimate: some courses (e.g. a one-year project
      // graded in a later term) simply have no internal marks this semester.
      const withoutMarks = [...attendanceByCourse.entries()]
        .filter(([code]) => !withMarks.has(code))
        .map(([code, percent]) => ({
          courseCode: code,
          attendancePercent: percent,
          note: "No internal marks record for this course this semester.",
        }));

      return {
        semesterId: summary.semesterId,
        attendanceRule: summary.attendanceRule,
        courses,
        totals: summary.totals,
        ...(withoutMarks.length
          ? {
              coursesWithoutMarks: withoutMarks,
              coursesWithoutMarksNote:
                "These courses have attendance but no internal marks record this semester. " +
                "That is expected for work graded in a later term (e.g. a full-year project " +
                "or clinic); it is not a fetch failure.",
            }
          : {}),
        note: summary.note,
      };
    },
    {
      emptyMessage:
        "No marks records found, so no internal totals. Internal assessments may not be published yet for this semester.",
    }
  );
}