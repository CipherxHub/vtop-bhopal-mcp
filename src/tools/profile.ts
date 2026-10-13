import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VtopClient } from "../services/vtop-client.js";
import { parseProfile, parseProgrammeBranch } from "../services/vtop-parser.js";
import { EmptySchema } from "../schemas/index.js";
import { mkJsonTool } from "./_helpers.js";

export function registerProfileTool(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "get_profile",
    "Get student profile (name, registration number, application number, program, branch, school, email, phone, blood group). If the response contains NOT_AUTHENTICATED, immediately call get_captcha then login then retry this tool. login auto-uses VTOP_USERNAME/VTOP_PASSWORD env vars if set; if login replies that credentials are missing, ask the user for their VTOP username and password and call login again with them. Requires login.",
    EmptySchema.shape,
    async () => {
      const profile = parseProfile(await client.getProfileHtml());
      try {
        const pb = parseProgrammeBranch(await client.getGradeHistoryHtml());
        if (pb) Object.assign(profile, pb);
      } catch {
        /* keep the profile-page values; grade history is a bonus */
      }
      return profile;
    },
  );
}
