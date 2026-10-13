import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VtopClient } from "../services/vtop-client.js";
import {
  parseGradeHistory,
  parseSemesterGrades,
} from "../services/vtop-parser.js";
import { ENDPOINTS } from "../services/constants.js";
import { SemesterInputSchema, EmptySchema } from "../schemas/index.js";
import { mkJsonTool } from "./_helpers.js";

export function registerGradesTool(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "get_grade_history",
    "Get cumulative grade history (CGPA, total earned credits, per-semester GPA + courses + grades, grouped by exam month). If the response contains NOT_AUTHENTICATED, immediately call get_captcha then login then retry this tool. login auto-uses VTOP_USERNAME/VTOP_PASSWORD env vars if set; if login replies that credentials are missing, ask the user for their VTOP username and password and call login again with them. Requires login.",
    EmptySchema.shape,
    async () => parseGradeHistory(await client.getGradeHistoryHtml())
  );

  mkJsonTool(
    server,
    "get_semester_grades",
    "Get grades for a specific semester (course-wise letter grades + GPA). IMPORTANT: for a semester still in progress VTOP publishes no results, and this tool then returns `published: false`, `gpa: null` and an explanatory message — that is NOT a GPA of 0. semesterId is optional; omit for current semester. If the response contains NOT_AUTHENTICATED, follow the error's `recovery` array and retry. Requires login.",
    SemesterInputSchema.shape,
    async ({ semesterId }) => {
      const id = semesterId ?? (await client.getCurrentSemesterId());
      const html = await client.fetchPage(ENDPOINTS.semesterGrades, {
        semesterSubId: id,
      });
      const result = parseSemesterGrades(html);
      // An in-progress term has no results yet. Say so plainly instead of
      // returning a GPA of 0, which reads like academic failure.
      if (!result.published) {
        return {
          ...result,
          message:
            "VTOP has not published results for this semester yet — it is still in " +
            "progress. This is NOT a GPA of 0. Use get_grade_history for results " +
            "from completed semesters.",
        };
      }
      return result;
    },
    { emptyMessage: "No grades found for this semester." }
  );
}
