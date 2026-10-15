import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VtopClient } from "../services/vtop-client.js";
import {
  parseFacultyDetail,
  parseFacultySearch,
} from "../services/vtop-parser.js";
import type { FacultyDetail, FacultyMatch } from "../types/index.js";
import { FacultySearchSchema } from "../schemas/index.js";
import { mkJsonTool } from "./_helpers.js";

/**
 * Details are fetched per match, so an absurdly broad fragment cannot turn
 * one call into a crawl of the whole directory.
 */
const MAX_DETAILS = 10;

export function registerFacultyTools(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "search_faculty",
    "Faculty directory search with full details in one call (Academics → Faculty Info): pass a name fragment and get back every matching faculty member — name, designation, school — each with their detail card (department, email, cabin; cabin is null when VTOP publishes none). The fragment needs minimum 3 characters, letters and spaces only, mirroring VTOP's own search-box validation. Details are fetched for up to 10 matches; beyond that, refine the fragment. Use get_timetable when you want the faculty teaching YOUR registered courses instead. If the response contains NOT_AUTHENTICATED, immediately call get_captcha then login then retry this tool. login auto-uses VTOP_USERNAME/VTOP_PASSWORD env vars if set; if login replies that credentials are missing, ask the user for their VTOP username and password and call login again with them. Requires login.",
    FacultySearchSchema.shape,
    async ({ name }) => {
      const q = name.trim();
      if (q.length < 3) {
        throw new Error("name must be at least 3 characters — VTOP's search box enforces the same minimum.");
      }
      if (/[^a-zA-Z ]/.test(q)) {
        throw new Error("name may only contain letters and spaces — VTOP's search box blocks everything else.");
      }
      const matches: FacultyMatch[] = parseFacultySearch(await client.searchFacultyHtml(q));
      if (matches.length === 0) {
        return {
          query: q,
          count: 0,
          faculty: [],
          note: "No faculty member matches. VTOP matches name fragments — try a shorter fragment of the surname.",
        };
      }
      const capped = matches.slice(0, MAX_DETAILS);
      const faculty: (FacultyMatch & { detail: FacultyDetail | null })[] = [];
      for (const m of capped) {
        if (!m.employeeId) {
          faculty.push({ ...m, detail: null });
          continue;
        }
        faculty.push({
          ...m,
          detail: parseFacultyDetail(m.employeeId, await client.getFacultyDetailHtml(m.employeeId)),
        });
      }
      return {
        query: q,
        count: matches.length,
        faculty,
        ...(matches.length > capped.length
          ? { note: `Details fetched for the first ${capped.length} of ${matches.length} matches — refine the fragment for the rest.` }
          : {}),
      };
    },
  );
}
