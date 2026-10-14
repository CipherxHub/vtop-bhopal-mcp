import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VtopClient } from "./services/vtop-client.js";
import type { Credentials } from "./types/index.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerAttendanceTool, registerAttendanceDetailTool } from "./tools/attendance.js";
import { registerTimetableTool } from "./tools/timetable.js";
import { registerMarksTool } from "./tools/marks.js";
import { registerExamScheduleTool } from "./tools/exam-schedule.js";
import { registerGradesTool } from "./tools/grades.js";
import { registerProfileTool } from "./tools/profile.js";
import { registerCurriculumTool } from "./tools/curriculum.js";
import { registerAttendanceCalcTool } from "./tools/attendance-calc.js";
import { registerTodayClassesTool } from "./tools/today.js";
import { registerCalendarTool, registerSemesterInfoTool } from "./tools/calendar.js";
import { registerPassEligibilityTool } from "./tools/pass-eligibility.js";
import { registerLeaveTools } from "./tools/leave.js";
import { registerStudentInfoTools } from "./tools/student-info.js";
import { registerFeesTools, registerCurriculumBasketTools } from "./tools/fees-curriculum.js";
// NOTE: there is deliberately no grade predictor. Predicting a letter grade
// needs the class average and spread, which VTOP does not expose, and VIT
// grades relatively - so any prediction would be guesswork presented as data.

export function createServer(
  credentials?: Credentials,
  sharedClient?: VtopClient,
  previewTokenOwner?: string,
): {
  server: McpServer;
  client: VtopClient;
} {
  const server = new McpServer({
    name: "vtop-mcp",
    version: "0.1.5",
  });

  // In multi-user HTTP mode the caller passes a client shared across all of a
  // user's MCP sessions, so the session armed by get_captcha is the same one
  // login uses (some clients open a fresh MCP session per tool call). Falls
  // back to a fresh client for stdio / single-call use.
  const client = sharedClient ?? new VtopClient();

  // Register all tools. `credentials`, when present, are the per-user VTOP
  // credentials decrypted from the connector token (multi-user HTTP mode).
  registerAuthTools(server, client, credentials);
  registerAttendanceTool(server, client);
  registerAttendanceDetailTool(server, client);
  registerTimetableTool(server, client);
  registerMarksTool(server, client);
  registerExamScheduleTool(server, client);
  registerGradesTool(server, client);
  registerProfileTool(server, client);
  registerCurriculumTool(server, client);
  registerAttendanceCalcTool(server, client);
  registerTodayClassesTool(server, client);
  registerCalendarTool(server, client);
  registerSemesterInfoTool(server, client);
  registerPassEligibilityTool(server, client);
  registerStudentInfoTools(server, client);
  registerFeesTools(server, client);
  registerCurriculumBasketTools(server, client);
  // Stdio gets an unpredictable process-local owner; HTTP supplies a stable
  // hash of the authenticated connector token so previews survive a fresh MCP
  // transport while remaining unusable by another connector user.
  registerLeaveTools(server, client, previewTokenOwner ?? randomUUID());
  // registerPredictGradesTool(server, client); // inactive — see import note above

  return { server, client };
}
