import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VtopClient } from "../services/vtop-client.js";
import { parseAttendance, parseAttendanceDetailRefs, parseAttendanceDetailRows } from "../services/vtop-parser.js";
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

export function registerAttendanceDetailTool(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "get_attendance_detail",
    "Per-class attendance for one course: every posted session with its date and outcome (Present / Absent / On Duty). Ask 'was I present on 2026-10-12 in BCSE302L?' with courseCode + date; omit date to list all posted sessions. A date with no row means VTOP posted nothing for it — NOT POSTED, never absent. If the response contains NOT_AUTHENTICATED, call get_captcha then login then retry. Requires login.",
    {
      ...SemesterInputSchema.shape,
      courseCode: z.string().describe("Course code, e.g. 'BCSE302L' (case-insensitive)."),
      date: z
        .string()
        .optional()
        .describe("ISO date YYYY-MM-DD to check. Omit to list every posted session for the course."),
    },
    async ({ semesterId, courseCode, date, refresh }) => {
      // Fail loud on garbage dates: string-compared calendar math would
      // otherwise read them as "no classes".
      if (date !== undefined) {
        const m = /^(\d{4})-(0[1-9]|1[0-2])-(\d{2})$/.exec(date);
        const ok =
          !!m &&
          (() => {
            const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
            return dt.getUTCFullYear() === +m[1] && dt.getUTCMonth() === +m[2] - 1 && dt.getUTCDate() === +m[3];
          })();
        if (!ok) {
          throw new Error(`"${date}" is not a real calendar date. Use ISO YYYY-MM-DD (e.g. 2026-10-20).`);
        }
      }
      const id = semesterId ?? (await client.getCurrentSemesterId());
      const refs = parseAttendanceDetailRefs(await client.getAttendanceHtml(id, refresh ?? false));
      const ref = refs.find((r) => r.courseCode.toUpperCase() === courseCode.trim().toUpperCase());
      if (!ref) {
        throw new Error(
          `No per-class detail handle for course "${courseCode}" in this semester — VTOP published no View control for it.`,
        );
      }
      const rows = parseAttendanceDetailRows(await client.getAttendanceDetailHtml(ref.params));
      if (date === undefined) {
        return { courseCode: ref.courseCode, courseName: ref.courseName, count: rows.length, rows };
      }
      const mine = rows.filter((r) => r.date === date);
      if (mine.length === 0) {
        return {
          courseCode: ref.courseCode,
          date,
          verdict: "NOT POSTED",
          message: "VTOP has posted nothing for this course on this date — not posted, never absent.",
          rows: [],
        };
      }
      // One date can hold several sessions (theory + lab rows). A single
      // headline must not masquerade partial attendance as a clean outcome.
      const markers = new Set(mine.map((r) => r.marker));
      const verdict =
        markers.size === 1
          ? markers.has("present")
            ? "PRESENT"
            : markers.has("absent")
              ? "ABSENT"
              : markers.has("on-duty")
                ? "ON DUTY"
                : "UNKNOWN"
          : "MIXED";
      return {
        courseCode: ref.courseCode,
        date,
        verdict,
        ...(verdict === "MIXED"
          ? { message: "Sessions on this date disagree — read the rows, not just the headline." }
          : {}),
        rows: mine,
      };
    },
    {
      emptyMessage: "VTOP posted no per-class rows for this course.",
    },
  );
}
