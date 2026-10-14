#!/usr/bin/env tsx
/**
 * Offline tool tests — exercise each tool end-to-end through the real MCP
 * machinery (createServer → InMemoryTransport → SDK Client → tools/call) but
 * with a FAKE VtopClient that returns the shared fixtures instead of hitting
 * VTOP. This verifies the wiring (schemas, handlers, JSON shape) and the
 * tool-level logic (date-aware attendance, OD totals, GPA, calendar filters)
 * without any network.
 *   npm run test:tools
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { VtopClient } from "../src/services/vtop-client.js";
import type { CalendarDay } from "../src/services/attendance-calc.js";
import { ENDPOINTS } from "../src/services/constants.js";
import * as F from "./fixtures.js";

// --- deterministic dates (so the date-aware tests don't rot over time) ------
const istToday = (): string =>
  new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const plusDays = (iso: string, n: number): string =>
  new Date(new Date(`${iso}T00:00:00Z`).valueOf() + n * 86400_000).toISOString().slice(0, 10);

const TODAY = istToday();
const DAY1 = plusDays(TODAY, 7); // an instructional day, forced MON day-order
const DAY2 = plusDays(TODAY, 14); // another instructional MON-order day
const HOLIDAY = plusDays(TODAY, 3);
const UNTIL = plusDays(TODAY, 21);

// Calendar the fake client serves. Forcing dayOrderWeekday="MON" makes the two
// instructional days map to the TIMETABLE_HTML Monday grid regardless of which
// weekday they actually land on — keeps the test stable forever.
const CALENDAR: CalendarDay[] = [
  { date: DAY1, instructional: true, dayOrderWeekday: "MON", label: "Working Day" },
  { date: HOLIDAY, instructional: false, dayOrderWeekday: null, label: "Test Holiday" },
  { date: DAY2, instructional: true, dayOrderWeekday: "MON", label: "Working Day" },
];

// --- fake VtopClient: returns fixtures, no network ---------------------------
const fakeClient = {
  async getCurrentSemesterId(): Promise<string> {
    return "TESTSEM";
  },
  async getSemesters(): Promise<{ id: string; name: string }[]> {
    return [{ id: "TESTSEM", name: "Fall Semester 2025-26" }];
  },
  async getTimetableHtml(): Promise<string> {
    return F.TIMETABLE_HTML;
  },
  async getGradeHistoryHtml(): Promise<string> {
    return F.GRADE_HISTORY_HTML;
  },
  async getProfileHtml(): Promise<string> {
    return F.PROFILE_HTML;
  },
  async getCalendar(_id: string, fromISO: string, toISO: string): Promise<CalendarDay[]> {
    return CALENDAR.filter((d) => d.date >= fromISO && d.date <= toISO).sort((a, b) =>
      a.date.localeCompare(b.date),
    );
  },
  async getMarksHtml(): Promise<string> {
    return F.MARKS_HTML;
  },
  async getAttendanceHtml(): Promise<string> {
    return F.ATT_MAIN_HTML;
  },
  async getExamScheduleHtml(): Promise<string> {
    return F.EXAM_SCHEDULE_BHOPAL_HTML;
  },
  async fetchPage(endpoint: string): Promise<string> {
    switch (endpoint) {
      case ENDPOINTS.attendance:
        return F.ATT_MAIN_HTML;
      case ENDPOINTS.attendanceDetail:
        return F.ATT_DETAIL_HTML;
      case ENDPOINTS.marks:
        return F.MARKS_HTML;
      case ENDPOINTS.semesterGrades:
        return F.SEMESTER_GRADES_HTML;
      default:
        throw new Error(`fakeClient.fetchPage: unexpected endpoint "${endpoint}"`);
    }
  },
} as unknown as VtopClient;

// --- harness ----------------------------------------------------------------
let passed = 0;
const check = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

async function callJson<T = any>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  assert.equal(res.isError ?? false, false, `${name} returned isError: ${res.content?.[0]?.text}`);
  const text = res.content.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text) as T;
}

async function main() {
  const { server } = createServer(undefined, fakeClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tool-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  // get_profile -------------------------------------------------------------
  await check("get_profile parses the profile fixture", async () => {
    const p = await callJson(client, "get_profile");
    assert.equal(p.name, "Ada Lovelace");
    assert.equal(p.registrationNumber, "21BCE1234");
    assert.equal(p.branch, "Computer Science and Engineering");
    assert.equal(p.email, "ada@vitstudent.ac.in");
  });

  // get_marks ---------------------------------------------------------------
  await check("get_marks returns the parsed mark record", async () => {
    const marks = await callJson(client, "get_marks");
    assert.equal(marks.length, 1);
    assert.equal(marks[0].courseCode, "BTST101L");
    assert.equal(marks[0].marks[0].scored, 40);
  });

  // calculate_attendance (count-only) ---------------------------------------
  await check("calculate_attendance (no deadline) computes buffer + recovery", async () => {
    const r = await callJson(client, "calculate_attendance");
    assert.equal(r.thresholdPercent, 74);
    assert.equal(r.overallSafe, false);
    const ds = r.courses.find((c: any) => c.courseCode === "BTST101L");
    assert.equal(ds.isSafe, true);
    assert.equal(ds.bunkBuffer, 10);
    const mk = r.courses.find((c: any) => c.courseCode === "BTST202L");
    assert.equal(mk.isSafe, false);
    assert.equal(mk.classesToRecover, 27);
  });

  // calculate_attendance (deadline-aware + bunkDates) -----------------------
  await check("calculate_attendance (untilDate + bunkDates) projects the deadline", async () => {
    const r = await callJson(client, "calculate_attendance", {
      untilDate: UNTIL,
      bunkDates: [DAY1],
    });
    assert.equal(r.untilDate, UNTIL);
    // Two instructional days in range, each running the MON grid (3 courses).
    assert.equal(r.perDay.length, 2);
    assert.equal(r.perDay[0].courses.length, 3);
    const mk = r.courses.find((c: any) => c.courseCode === "BTST202L");
    assert.equal(mk.deadline.upcomingSessions, 2);
    assert.equal(mk.deadline.canBeSafeByDeadline, false); // 32/52 ≈ 61.5%
    assert.equal(mk.deadline.mustAttendInRange, null);
    assert.equal(mk.plannedBunk.bunkedSessions, 1);
    assert.equal(mk.plannedBunk.safe, false);
  });

  // calculate_attendance (single course filter) -----------------------------
  await check("calculate_attendance filters to one course", async () => {
    const r = await callJson(client, "calculate_attendance", { courseCode: "btst101l" });
    assert.equal(r.courses.length, 1);
    assert.equal(r.courses[0].courseCode, "BTST101L");
  });

  // get_today_classes -------------------------------------------------------
  await check("get_today_classes lists the day's classes in order", async () => {
    const r = await callJson(client, "get_today_classes", { date: DAY1 });
    assert.equal(r.instructional, true);
    assert.equal(r.dayOrderFollowed, "MON");
    assert.equal(r.classes.length, 3);
    const a1 = r.classes.find((c: any) => c.slot === "A1");
    assert.equal(a1.courseCode, "BTST101L");
    assert.equal(a1.venue, "AB1-101");
    assert.equal(a1.startTime, "08:00");
  });
  await check("get_today_classes reports a holiday", async () => {
    const r = await callJson(client, "get_today_classes", { date: HOLIDAY });
    assert.equal(r.instructional, false);
    assert.equal(r.classes.length, 0);
  });

  // get_calendar ------------------------------------------------------------
  await check("get_calendar query finds a named day", async () => {
    const r = await callJson(client, "get_calendar", { query: "holiday" });
    assert.equal(r.count, 1);
    assert.equal(r.days[0].date, HOLIDAY);
    assert.equal(r.days[0].instructional, false);
  });
  await check("get_calendar holidaysOnly returns only non-instructional days", async () => {
    const r = await callJson(client, "get_calendar", { holidaysOnly: true });
    assert.equal(r.days.length, 1);
    assert.equal(r.days[0].label, "Test Holiday");
  });
  await check("get_calendar rejects a malformed month instead of ignoring it", async () => {
    const res = (await client.callTool({ name: "get_calendar", arguments: { month: "2026-13" } })) as {
      isError?: boolean;
      content: { type: string; text?: string }[];
    };
    assert.equal(res.isError ?? false, true, "bad month must be an error");
    assert.match(res.content.find((c) => c.type === "text")?.text ?? "", /YYYY-MM/);
  });
  await check("calculate_attendance rejects a malformed untilDate", async () => {
    const res = (await client.callTool({ name: "calculate_attendance", arguments: { untilDate: "30-10-2026" } })) as {
      isError?: boolean;
      content: { type: string; text?: string }[];
    };
    assert.equal(res.isError ?? false, true, "bad date must be an error");
    assert.match(res.content.find((c) => c.type === "text")?.text ?? "", /YYYY-MM-DD/);
  });


  await client.close();
  await server.close();
  console.log(`\n${passed} checks passed.`);
}

main().catch((err) => {
  console.error("\n[tool-test] FAIL:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
