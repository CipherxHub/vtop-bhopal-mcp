import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VtopClient } from "../services/vtop-client.js";
import { VtopError } from "../services/errors.js";
import {
  parseAttendance,
  parseAttendanceDetailRefs,
  parseAttendanceDetailRows,
  parseTimetableGrid,
} from "../services/vtop-parser.js";
import { checkAttendanceTotals, scheduleFromGrid } from "../services/attendance-audit.js";
import { pMap } from "../services/concurrency.js";
import { SemesterInputSchema } from "../schemas/index.js";
import { mkJsonTool } from "./_helpers.js";

/** How many courses' detail pages one call may fetch. */
const DETAIL_COURSE_LIMIT = 20;

export function registerAttendanceAuditTools(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "check_attendance_totals",
    "Does VTOP's own 'total classes' match the sessions the timetable and academic " +
      "calendar imply? For every course it reports VTOP's total, the expected number of " +
      "sessions, and the difference. A difference is information, not an error: VTOP counts " +
      "classes its own way (cancelled sessions, late starts, make-up classes, working-Saturday " +
      "day-orders). Use this when a projection (classes left, how many you may skip) and the " +
      "headline percentage seem to disagree. Read-only. Requires login.",
    SemesterInputSchema.shape,
    async ({ semesterId, refresh }) => {
      const id = semesterId ?? (await client.getCurrentSemesterId());
      const attHtml = await client.getAttendanceHtml(id, refresh ?? false);
      const records = parseAttendance(attHtml);
      if (records.length === 0) {
        throw new VtopError(
          "UPSTREAM",
          "VTOP returned no attendance rows to check against the calendar.",
          "Not treated as 'everything matches'.",
        );
      }
      const grid = parseTimetableGrid(await client.getTimetableHtml(id));
      const schedule = scheduleFromGrid(grid);
      const calendar = await client.getCalendar(id, "1900-01-01", "2999-12-31");
      const checks = checkAttendanceTotals(records, schedule, calendar);
      const mismatches = checks.filter((c) => !c.matches);
      return {
        semesterId: id,
        coursesChecked: checks.length,
        coursesMatching: checks.length - mismatches.length,
        coursesDifferent: mismatches.length,
        allMatch: mismatches.length === 0,
        checks,
        note:
          "The expected count comes from the weekly timetable crossed with the academic " +
          "calendar (instructional days only, working-Saturday day-orders respected). " +
          "VTOP's total is its own count and is never overwritten here.",
      };
    },
  );

  mkJsonTool(
    server,
    "get_missed_classes",
    "Every class you have missed this semester: per course, the dates you were absent " +
      "(with the slot), and the total. On-duty classes are not absences. A class VTOP has " +
      "not posted is not counted — it is unknown, not missed. Read-only. Requires login.",
    {
      ...SemesterInputSchema.shape,
      courseCode: z
        .string()
        .optional()
        .describe("Limit to one course code (case-insensitive). Omit for all courses."),
    },
    async ({ semesterId, courseCode, refresh }) => {
      const id = semesterId ?? (await client.getCurrentSemesterId());
      const attHtml = await client.getAttendanceHtml(id, refresh ?? false);
      const records = parseAttendance(attHtml);
      const wanted = courseCode?.trim().toUpperCase();
      const targets = wanted
        ? records.filter((r) => r.courseCode.toUpperCase() === wanted)
        : records;
      if (targets.length === 0) {
        throw new Error(
          wanted
            ? `No attendance record for course "${courseCode}" in this semester.`
            : "VTOP published no attendance records for this semester.",
        );
      }
      const refs = parseAttendanceDetailRefs(attHtml);
      const byCode = new Map<string, typeof refs>();
      for (const ref of refs) {
        const key = ref.courseCode.toUpperCase();
        const list = byCode.get(key) ?? [];
        list.push(ref);
        byCode.set(key, list);
      }
      const limit = Math.min(targets.length, DETAIL_COURSE_LIMIT);
      const selected = targets.slice(0, limit);
      const perCourse = await pMap(
        selected,
        async (rec) => {
          const key = rec.courseCode.toUpperCase();
          const handles = byCode.get(key) ?? [];
          const absences: { date: string; timing: string; status: string }[] = [];
          let onDuty = 0;
          let posted = 0;
          for (const handle of handles) {
            let rows: ReturnType<typeof parseAttendanceDetailRows> = [];
            try {
              rows = parseAttendanceDetailRows(await client.getAttendanceDetailHtml(handle.params));
            } catch (err) {
              if (err instanceof VtopError && err.code === "NOT_AUTHENTICATED") throw err;
              // One unreadable detail page must not lose the other courses.
              continue;
            }
            for (const row of rows) {
              posted++;
              if (row.marker === "absent") absences.push({ date: row.date, timing: row.timing, status: row.status });
              else if (row.marker === "on-duty") onDuty++;
            }
          }
          absences.sort((a, b) => a.date.localeCompare(b.date));
          return {
            courseCode: rec.courseCode,
            courseName: rec.courseName,
            missed: absences.length,
            absences,
            onDuty,
            posted,
          };
        },
        4,
      );

      const total = perCourse.reduce((s, c) => s + c.missed, 0);
      return {
        semesterId: id,
        coursesExamined: perCourse.length,
        coursesSkipped:
          targets.length > limit
            ? `${targets.length - limit} course(s) not examined (limit ${DETAIL_COURSE_LIMIT} per call)`
            : null,
        totalMissed: total,
        perCourse,
        note:
          "On-duty classes are not absences, and a class VTOP has not posted is unknown, " +
          "not missed. Use get_attendance_detail for one course's full day-by-day list.",
      };
    },
  );
}
