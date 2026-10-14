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
let statusCalls = 0;
let formCalls = 0;
const STATUS_WITH_CANCEL = `<table>
  <tr><th>Leave Id</th><th>Visit Place</th><th>Reason</th><th>Leave Type</th>
  <th>From</th><th>To</th><th>Status</th><th>Remarks</th><th>Action</th></tr>
  <tr><td>L9000001</td><td>Bhopal</td><td>Family function.</td><td>DAY OUTING</td>
  <td>07-OCT-2026 12:29</td><td>07-OCT-2026 18:30</td><td>PROCTOR APPROVAL PENDING</td>
  <td></td><td><a href="hostels/student/leave/4?control=cancel&leaveId=L9000001">Cancel</a></td></tr>
  <tr><td>L9000002</td><td>Sehore</td><td>Medical check-up.</td><td>SPECIAL OUTING</td>
  <td>08-OCT-2026 09:00</td><td>08-OCT-2026 18:00</td><td>REQUEST APPROVED</td><td></td><td></td></tr>
</table>`;
const STATUS_CANCELLED = (id: string) => `<table>
  <tr><th>Leave Id</th><th>Status</th><th>Remarks</th></tr>
  <tr><td>${id}</td><td>CANCELLED</td><td></td></tr>
</table>`;

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
  async getAttendanceDetailHtml(): Promise<string> {
    return F.ATT_DETAIL_HTML;
  },
  async getLeaveStatusHtml(): Promise<string> {
    statusCalls++;
    return STATUS_WITH_CANCEL;
  },
  async cancelLeaveApplication(leaveId: string): Promise<string> {
    return STATUS_CANCELLED(leaveId);
  },
  async getExamScheduleHtml(): Promise<string> {
    return F.EXAM_SCHEDULE_BHOPAL_HTML;
  },
  async getLeaveFormHtml(): Promise<string> {
    formCalls++;
    return `<select id="leaveCode"><option value="">-Select-</option><option value="OG1">DAY OUTING</option></select>`;
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


  await check("get_attendance_detail answers present/absent/not-posted per day", async () => {
    // ATT_DETAIL_HTML rows: 01-Jan-2026 Present, 03-Jan-2026 On Duty, ...
    const present = await callJson(client, "get_attendance_detail", { courseCode: "BTST101L", date: "2026-01-01" });
    assert.equal(present.verdict, "PRESENT");
    const missing = await callJson(client, "get_attendance_detail", { courseCode: "BTST101L", date: "2026-02-02" });
    assert.equal(missing.verdict, "NOT POSTED");
    const od = await callJson(client, "get_attendance_detail", { courseCode: "BTST101L", date: "2026-01-03" });
    assert.equal(od.verdict, "ON DUTY");
    const ab = await callJson(client, "get_attendance_detail", { courseCode: "BTST101L", date: "2026-01-07" });
    assert.equal(ab.verdict, "ABSENT");
    const all = await callJson(client, "get_attendance_detail", { courseCode: "BTST101L" });
    assert.ok(all.count >= 4 && all.rows.length === all.count);
  });
  await check("get_attendance_detail rejects unknown courses and bad dates", async () => {
    const noRef = (await client.callTool({ name: "get_attendance_detail", arguments: { courseCode: "NOPE9999" } })) as {
      isError?: boolean;
    };
    assert.equal(noRef.isError ?? false, true, "unknown course must be an error");
    const badDate = (await client.callTool({ name: "get_attendance_detail", arguments: { courseCode: "BTST101L", date: "yesterday" } })) as {
      isError?: boolean;
    };
    assert.equal(badDate.isError ?? false, true, "bad date must be an error");
  });

  await check("get_semester_info reports bounds from the calendar", async () => {
    // Fake calendar: DAY1..DAY2 instructional (both future), one holiday.
    const r = await callJson(client, "get_semester_info");
    assert.equal(r.semesterId, "TESTSEM");
    assert.equal(r.name, "Fall Semester 2025-26");
    assert.equal(r.firstInstructionalDay, DAY1);
    assert.equal(r.lastInstructionalDay, DAY2);
    assert.equal(r.instructionalDaysTotal, 2);
    assert.equal(r.instructionalDaysRemaining, 2);
    assert.equal(r.teachingOver, false);
  });
  await check("calculate_attendance toTermEnd resolves to the last instructional day", async () => {
    const r = await callJson(client, "calculate_attendance", { toTermEnd: true });
    assert.equal(r.untilDate, DAY2);
    assert.equal(r.resolvedToTermEnd, true);
    assert.ok(r.courses.length > 0);
    assert.equal(r.verdict ?? null, null, "term still running: no locked verdict");
  });
  await check("teaching-over term reports locked figures, no projection", async () => {
    // Calendar with its only instructional day in the past: the term is over.
    const pastClient = {
      ...fakeClient,
      getCalendar: async (): Promise<CalendarDay[]> => [
        { date: "2020-01-06", instructional: true, dayOrderWeekday: "MON", label: "Working Day" },
      ],
    } as unknown as VtopClient;
    const { server: pastServer } = createServer(undefined, pastClient);
    const [t2, s2] = InMemoryTransport.createLinkedPair();
    const c2 = new Client({ name: "tool-test-past", version: "0.0.0" });
    await Promise.all([pastServer.connect(s2), c2.connect(t2)]);
    const info = (await c2.callTool({ name: "get_semester_info", arguments: {} })) as any;
    const infoJson = JSON.parse(info.content.find((c: any) => c.type === "text")?.text ?? "{}");
    assert.equal(infoJson.teachingOver, true);
    assert.match(infoJson.note ?? "", /final/);
    const calc = (await c2.callTool({ name: "calculate_attendance", arguments: { toTermEnd: true } })) as any;
    const calcJson = JSON.parse(calc.content.find((c: any) => c.type === "text")?.text ?? "{}");
    assert.ok(calcJson.verdict, "locked term must produce a final verdict");
    assert.equal(calcJson.termBounds.teachingOver, true);
    await c2.close();
    await pastServer.close();
  });

  await check("cancel_leave previews with status + withdrawability, then withdraws", async () => {
    const preview = await callJson(client, "cancel_leave", { leaveId: "L9000001" });
    assert.match(preview.mode, /PREVIEW/);
    assert.equal(preview.leave.status, "PROCTOR APPROVAL PENDING");
    assert.equal(preview.withdrawControlPublished, true);
    assert.ok(preview.previewToken, "preview mints a token");
    const done = await callJson(client, "cancel_leave", {
      leaveId: "L9000001",
      confirm: true,
      previewToken: preview.previewToken,
    });
    assert.equal(done.mode, "WITHDRAWN");
  });
  await check("cancel_leave rejects unknown ids and bogus tokens without VTOP touch", async () => {
    const unknown = await callJson(client, "cancel_leave", { leaveId: "L0000000" });
    assert.match(unknown.mode, /REJECTED/);
    const before = statusCalls;
    const bad = await callJson(client, "cancel_leave", {
      leaveId: "L9000001",
      confirm: true,
      previewToken: "garbage",
    });
    assert.match(bad.mode, /CONFIRM REJECTED/);
    assert.equal(statusCalls, before, "bogus confirm must cost zero status fetches");
  });

  await check("apply_leave bogus confirm costs zero VTOP reads", async () => {
    // The confirm handler must verify the token before the form fetch,
    // semester lookup, calendar, timetable and exams. A forged token that
    // still triggers reads is a DoS amplifier in exposed single-user mode.
    const before = formCalls;
    const badApply = (await client.callTool({
      name: "apply_leave",
      arguments: {
        leaveCode: "OG1",
        visitingPlace: "Bhopal",
        leaveFromDate: "2026-10-20",
        fromTime: "09:00",
        leaveToDate: "2026-10-20",
        toTime: "18:00",
        reason: "Family function in Bhopal.",
        confirm: true,
        previewToken: "garbage",
      },
    })) as { content: { type: string; text?: string }[] };
    const text = badApply.content.find((c) => c.type === "text")?.text ?? "";
    assert.match(JSON.parse(text).mode, /CONFIRM REJECTED/);
    assert.equal(formCalls, before, "bogus confirm must not read the form");
  });

  await client.close();
  await server.close();
  console.log(`\n${passed} checks passed.`);
}

main().catch((err) => {
  console.error("\n[tool-test] FAIL:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
