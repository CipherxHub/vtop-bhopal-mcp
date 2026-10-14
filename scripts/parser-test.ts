#!/usr/bin/env tsx
/**
 * Offline regression tests for the HTML parsers, against the shared fixtures.
 *   npm run test:parser
 */
import assert from "node:assert/strict";
import {
  parseMarks,
  parseTimetableGrid,
  weeklyScheduleFromGrid,
  parseAcademicCalendar,
  parseAttendance,
  parseAttendanceDetailRefs,
  parseAttendanceDetail,
  parseGradeHistory,
  parseExamSchedule,
  parseProgrammeBranch,
  parseSemesterGrades,
} from "../src/services/vtop-parser.js";
import * as F from "./fixtures.js";

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ok  ${name}`); };

// --- marks (the #fixedTableContainer div-vs-table bug) ---
check("parseMarks extracts a record (div-wrapped table)", () => {
  const recs = parseMarks(F.MARKS_HTML);
  assert.equal(recs.length, 1);
  const r = recs[0];
  assert.equal(r.courseCode, "BTST101L");
  assert.equal(r.courseName, "Database Systems");
  assert.equal(r.slot, "A1");
  assert.equal(r.marks.length, 1);
  assert.deepEqual(r.marks[0], {
    component: "CAT - 1", maxMarks: 50, scored: 40, maxWeightage: 15, weightage: 12, average: 30, status: "Present",
  });
});
check("parseMarks returns [] on 'No data found'", () => {
  assert.equal(parseMarks("<div id='fixedTableContainer'>No data found</div>").length, 0);
});

// --- attendance main, Bhopal layout (used to loop forever: no <th> => colCount 0) ---
check("parseAttendance reads the Bhopal layout (td headers, combined detail cells)", () => {
  const recs = parseAttendance(F.ATT_MAIN_BHOPAL_HTML);
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0], {
    courseCode: "BTST101", courseName: "Database Systems", courseType: "Lecture and Tutorial Hours Only",
    slot: "A11", attended: 23, total: 31, percentage: 75,
  });
});

// --- exam schedule, Bhopal layout (extra row above the header) ---
check("parseExamSchedule reads the Bhopal layout", () => {
  const recs = parseExamSchedule(F.EXAM_SCHEDULE_BHOPAL_HTML);
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0], {
    examType: "FAT", courseCode: "BTST101", courseName: "Database Systems", slot: "A11",
    examDate: "17-OCT-2026", session: "AN1", time: "01:15 PM - 04:15 PM", venue: "", seatNo: "", seatLocation: "",
  });
});

// --- grade history, Bhopal (course code mistaken for exam month; P grades) ---
check("parseGradeHistory groups Bhopal rows by real exam month, P outside GPA", () => {
  const h = parseGradeHistory(F.GRADE_HISTORY_BHOPAL_HTML);
  assert.deepEqual(h.semesters.map((s) => s.semester), ["Oct-2023", "Jan-2024"]);
  assert.equal(h.semesters[0].grades.length, 2);
  assert.equal(h.semesters[0].gpa, 9); // the P course doesn't drag it down
});

check("parseProgrammeBranch reads the grade-history header", () => {
  assert.deepEqual(parseProgrammeBranch(F.GRADE_HISTORY_HEADER_HTML), {
    program: "B.Tech.", branch: "Electronics and Communication Engineering (AI)",
  });
});

check("parseSemesterGrades reads Bhopal's split Credits header", () => {
  assert.deepEqual(parseSemesterGrades(F.SEM_GRADES_BHOPAL_HTML), {
    grades: [{ courseCode: "BTST101", courseName: "Database Systems", courseType: "LT", credits: 3, grade: "B", gradePoints: 8 }],
    gpa: 8,
    published: true,
  });
});

check("parseAcademicCalendar (Bhopal): General label only; 'Activities Friday' day order", () => {
  const d = parseAcademicCalendar(F.CAL_BHOPAL_HTML, "01-OCT-2026");
  assert.deepEqual(d, [
    { date: "2026-10-16", instructional: false, dayOrderWeekday: null, label: "Term End Examinations" },
    { date: "2026-10-17", instructional: true, dayOrderWeekday: "FRI", label: "Remote Learning - Class/CAM Activities Friday" },
  ]);
});

// --- attendance main ---
check("parseAttendance reads attended/total/percentage", () => {
  const recs = parseAttendance(F.ATT_MAIN_HTML);
  assert.equal(recs.length, 2);
  assert.deepEqual(
    { c: recs[0].courseCode, a: recs[0].attended, t: recs[0].total, p: recs[0].percentage, slot: recs[0].slot },
    { c: "BTST101L", a: 45, t: 50, p: 90, slot: "A1" },
  );
  assert.equal(recs[1].courseCode, "BTST202L");
  assert.equal(recs[1].attended, 30);
});

check("parseAttendance reports dash cells as unknown, never zero", () => {
  // VTOP prints "-" for courses with no figures yet. Those must come back
  // null (unknown), not 0/0/0% (debarred with no attendance).
  const recs = parseAttendance(`<table id="getStudentDetails">
    <tr><th>Sl.No</th><th>Course Code</th><th>Course Title</th><th>Course Type</th>
    <th>Slot</th><th>Attended Classes</th><th>Total Classes</th>
    <th>Attendance Percentage</th><th>Attendance View</th></tr>
    <tr><td>1</td><td>BTST303L</td><td>Not Started</td><td>Theory Only</td>
    <td>B1</td><td>-</td><td>-</td><td>-</td><td></td></tr>
  </table>`);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].attended, null);
  assert.equal(recs[0].total, null);
  assert.equal(recs[0].percentage, null);
});

// --- timetable grid ---
check("parseTimetableGrid parses slot/course/venue/time", () => {
  const sessions = parseTimetableGrid(F.TIMETABLE_HTML);
  assert.equal(sessions.length, 3);
  const a1 = sessions.find((s) => s.slot === "A1")!;
  assert.equal(a1.courseCode, "BTST101L");
  assert.equal(a1.venue, "AB1-101");
  assert.equal(a1.startTime, "08:00");
  assert.equal(a1.type, "THEORY");
  assert.equal(a1.day, "MON");
  assert.equal(sessions.find((s) => s.type === "LAB")!.courseCode, "BTST101P");
  assert.deepEqual(weeklyScheduleFromGrid(sessions).MON.sort(), ["BTST101L", "BTST101P", "BTST202L"]);
});

// --- academic calendar ---
check("parseAcademicCalendar reads instructional + day-order + label", () => {
  const days = parseAcademicCalendar(F.CAL_HTML, "01-DEC-2025");
  const d8 = days.find((d) => d.date === "2025-12-08")!;
  assert.equal(d8.instructional, true);
  assert.equal(d8.dayOrderWeekday, null);
  assert.match(d8.label ?? "", /Working Day/i);
  const d13 = days.find((d) => d.date === "2025-12-13")!;
  assert.equal(d13.dayOrderWeekday, "THU");
  assert.match(d13.label ?? "", /Thursday Day Order/i);
  assert.equal(days.find((d) => d.date === "2025-12-07")!.instructional, false);
});

// --- attendance detail / OD ---
check("parseAttendanceDetailRefs extracts classId/slot/course", () => {
  const refs = parseAttendanceDetailRefs(F.ATT_MAIN_HTML);
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], {
    courseCode: "BTST101L", courseName: "Database Systems", classId: "CH001", slot: "A1+TA1",
    params: { classId: "CH001", slotName: "A1+TA1" },
  });
  assert.equal(refs[1].classId, "CH002");
});
check("parseAttendanceDetailRefs reads Bhopal's callStudentAttendanceDetailDisplay", () => {
  const refs = parseAttendanceDetailRefs(F.ATT_MAIN_BHOPAL_HTML);
  assert.deepEqual(refs, [{
    courseCode: "BTST101", courseName: "Database Systems", classId: "BP_BTST101_00100", slot: "A11",
    params: { semesterSubId: "BL0", registerNumber: "REG", courseId: "BP_BTST101_00100", courseType: "LT" },
  }]);
});
check("parseAttendanceDetail picks Bhopal's per-class table, not the summary", () => {
  assert.deepEqual(parseAttendanceDetail(F.ATT_DETAIL_BHOPAL_HTML), {
    present: 1, absent: 1, onDuty: 1, total: 3, odHours: 2, // one 90-min slot = 2 x 50-min periods
    odDates: ["25-09-2026"],
  });
});
check("parseAttendanceDetail counts statuses + OD hours (lab=2)", () => {
  const d = parseAttendanceDetail(F.ATT_DETAIL_HTML);
  assert.equal(d.present, 1);
  assert.equal(d.absent, 1);
  assert.equal(d.onDuty, 2);
  assert.equal(d.total, 4);
  assert.equal(d.odHours, 3);
});
check("parseAttendanceDetail handles 12-hour AM/PM timings (noon-crossing lab)", () => {
  const d = parseAttendanceDetail(F.ATT_DETAIL_AMPM_HTML);
  assert.equal(d.present, 1);
  assert.equal(d.onDuty, 2);
  // 1h OD theory + 3h OD lab (11:00 AM–01:40 PM); pre-fix this counted as 1+1.
  assert.equal(d.odHours, 4);
});

// --- grade history ---
check("parseGradeHistory reads CGPA + per-semester grades", () => {
  const h = parseGradeHistory(F.GRADE_HISTORY_HTML);
  assert.equal(h.cgpa, 8.43);
  assert.equal(h.totalCredits, 7);
  assert.equal(h.semesters.length, 1);
  assert.equal(h.semesters[0].semester, "Nov 2025");
  assert.equal(h.semesters[0].gpa, 8.43); // (3*9 + 4*8)/7
  assert.equal(h.semesters[0].grades.length, 2);
});
check("parseGradeHistory survives reordered columns + no tableContent class", () => {
  const h = parseGradeHistory(F.GRADE_HISTORY_REORDERED_HTML);
  assert.equal(h.cgpa, 8.43);
  assert.equal(h.semesters.length, 1);
  assert.equal(h.semesters[0].semester, "Nov 2025");
  assert.equal(h.semesters[0].gpa, 8.43); // (3*9 + 4*8)/7
  assert.equal(h.semesters[0].grades.length, 2);
  const db = h.semesters[0].grades.find((g) => g.courseCode === "BTST101L")!;
  assert.equal(db.grade, "A");
  assert.equal(db.credits, 3);
  assert.equal(db.courseName, "Database Systems");
});

check("semester grades report published:false and gpa:null when empty", () => {
  // An in-progress term must never look like a GPA of 0.
  const empty = parseSemesterGrades("<html><body>No records found</body></html>");
  assert.equal(empty.published, false);
  assert.equal(empty.gpa, null);
  assert.deepEqual(empty.grades, []);
});

check("grade history reports gpa:null for a term of only P grades", () => {
  // A term carrying only P (pass) courses has no GPA-bearing credit. Reporting
  // 0 there reads as a failed semester, which is exactly the bug being fixed.
  const html = `
    <table>
      <tr class="tableContent"><td>1</td><td>PLA1007L</td><td>Community Project</td><td>Project Only</td><td>3</td><td>P</td><td>May-2026</td><td>-</td></tr>
    </table>
    <table>
      <tr><td>Credits Registered</td><td>Credits Earned</td><td>CGPA</td></tr>
      <tr><td>3</td><td>3</td><td>0</td></tr>
    </table>`;
  const h = parseGradeHistory(html);
  assert.equal(h.semesters.length, 1);
  const term = h.semesters[0];
  assert.equal(term.semester, "May-2026");
  assert.equal(term.gpa, null, "no GPA-bearing credit -> null, not 0");
  assert.equal(term.grades.length, 1);
  assert.equal(term.grades[0].grade, "P");
});

console.log(`\n${passed} checks passed.`);
