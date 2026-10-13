import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VtopClient } from "../services/vtop-client.js";
import { parseExamSchedule } from "../services/vtop-parser.js";
import { SemesterInputSchema } from "../schemas/index.js";
import { mkJsonTool } from "./_helpers.js";

export function registerExamScheduleTool(
  server: McpServer,
  client: VtopClient
) {
  mkJsonTool(
    server,
    "get_exam_schedule",
    "Get exam schedule (CAT1/CAT2/FAT dates, timings, venues, seat numbers, row/col). If the response contains NOT_AUTHENTICATED, immediately call get_captcha then login then retry this tool. login auto-uses VTOP_USERNAME/VTOP_PASSWORD env vars if set; if login replies that credentials are missing, ask the user for their VTOP username and password and call login again with them. semesterId is optional; omit for current semester. Requires login.",
    SemesterInputSchema.shape,
    async ({ semesterId, refresh }) => {
      const id = semesterId ?? (await client.getCurrentSemesterId());
      return parseExamSchedule(await client.getExamScheduleHtml(id, refresh ?? false));
    },
    {
      emptyMessage:
        "No exam schedule found for this semester. It may not have been released yet.",
    }
  );
}
