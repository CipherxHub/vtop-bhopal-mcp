import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VtopClient } from "../services/vtop-client.js";
import { parseTimetable } from "../services/vtop-parser.js";
import { SemesterInputSchema } from "../schemas/index.js";
import { mkJsonTool } from "./_helpers.js";

export function registerTimetableTool(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "get_timetable",
    "Get class timetable: registered courses with slots, venues, faculty and credits, plus the actual weekly schedule. Each course carries a `sessions` array with every meeting it has (day, slot, THEORY/LAB, start and end time, venue) — a course with two slots a week appears twice. The top-level day/startTime/endTime mirror the first session. Use get_today_classes for 'what do I have today' (it applies the academic calendar and day-order overrides). semesterId is optional; omit for current semester. If the response contains NOT_AUTHENTICATED, follow the error's `recovery` array and retry. Requires login.",
    SemesterInputSchema.shape,
    async ({ semesterId }) => {
      const id = semesterId ?? (await client.getCurrentSemesterId());
      // getTimetableHtml is cached per semester, so this reuses a fetch that
      // getCurrentSemesterId has usually already made.
      const html = await client.getTimetableHtml(id);
      return parseTimetable(html);
    },
    {
      emptyMessage:
        "No timetable found for this semester. It may not have been published yet.",
    }
  );
}
