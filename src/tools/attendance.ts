import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VtopClient } from "../services/vtop-client.js";
import { parseAttendance } from "../services/vtop-parser.js";
import { SemesterInputSchema } from "../schemas/index.js";
import { mkJsonTool } from "./_helpers.js";

export function registerAttendanceTool(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "get_attendance",
    "Get attendance records for all courses (attended/total/percentage per course). If the response contains NOT_AUTHENTICATED, immediately call get_captcha then login then retry this tool. login auto-uses VTOP_USERNAME/VTOP_PASSWORD env vars if set; if login replies that credentials are missing, ask the user for their VTOP username and password and call login again with them. semesterId is optional; omit for current semester. Requires login.",
    SemesterInputSchema.shape,
    async ({ semesterId, refresh }) => {
      const id = semesterId ?? (await client.getCurrentSemesterId());
      return parseAttendance(await client.getAttendanceHtml(id, refresh ?? false));
    },
    {
      emptyMessage:
        "No attendance records found. The semester may not have started or the page format may have changed.",
    }
  );
}
