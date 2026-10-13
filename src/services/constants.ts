/**
 * Shared constants used across the VTOP client, parsers, and tools.
 * Centralized so endpoint URLs, error wording, and grade-letter sets
 * have exactly one source of truth.
 */
import { VtopError, describeForModel } from "./errors.js";

/** VTOP backend endpoint paths (relative to the /vtop base URL). */
export const ENDPOINTS = {
  attendance: "processViewStudentAttendance",
  timetable: "processViewTimeTable",
  marks: "examinations/doStudentMarkView",
  examSchedule: "examinations/doSearchExamScheduleForStudent",
  gradeHistory: "examinations/examGradeView/StudentGradeHistory",
  semesterGrades: "examinations/examGradeView/doStudentGradeView",
  profile: "studentsRecord/StudentProfileAllView",
  timetableForSemesters: "academics/common/StudentTimeTable",
  // Academic calendar is a 3-step flow: load the page for context, fetch the
  // month buttons, then fetch each month's day table. The latter two are
  // root-level actions (the page's relative AJAX resolves against /vtop/).
  calendarPreview: "academics/common/CalendarPreview",
  calendarMonthList: "getListForSemester",
  calendarMonth: "processViewCalendar",
  attendanceDetail: "processViewAttendanceDetail",
  // Hostel leave. VTOP drives this module with a `control` parameter rather
  // than separate paths: leave/1 is the page shell, leave/2 the request form,
  // leave/3 the submit action, leave/4 the status view. Every call carries
  // `_csrf`, the form fields, `authorizedID`, `form`, `control` and `x`
  // (UTC timestamp) — there is no `verifyMenu` handshake here, which is why
  // guessing at paths under hostel/* returned the menu-unavailable modal.
  leavePage: "hostels/student/leave/1",
  leaveForm: "hostels/student/leave/2",
  leaveSubmit: "hostels/student/leave/3",
  leaveStatus: "hostels/student/leave/4",
} as const;

/** `control` values for the leave module. */
export const LEAVE_CONTROL = {
  apply: "apply",
  submit: "submitControl2",
  status: "status",
} as const;

/** `form` name the leave form serializes under. */
export const LEAVE_FORM_NAME = "LeaveRequestForm";

/**
 * The leaveCode dropdown's data-controlName. Selecting a type fires
 * requestUpdate() against leaveForm with this control, and VTOP replies with
 * that type's own constraints (see VtopClient.getLeaveTypeConstraints).
 */
export const LEAVE_TYPE_CONTROL = "leaveCode";

/**
 * Leave types, exactly as VTOP publishes them (the `value` of each option in
 * the leaveCode dropdown). OG1 is DAY OUTING, which is the only type the 6 PM
 * in-time rule applies to — confirmed by the student.
 */
export const LEAVE_TYPES = [
  { code: "SO", label: "SPECIAL OUTING" },
  { code: "WP", label: "WITH PARENT LEAVE" },
  { code: "EP", label: "OFFICIAL LEAVES (GATE / CAMPUS INTERVIEW)" },
  { code: "SV", label: "SUMMER VACATION" },
  { code: "WV", label: "WINTER VACATION" },
  { code: "HT1", label: "HOME TOWN" },
  { code: "LG1", label: "LOCAL GUARDIAN" },
  { code: "EY1", label: "EMERGENCY LEAVE" },
  { code: "OG1", label: "DAY OUTING" },
] as const;

export type LeaveTypeCode = (typeof LEAVE_TYPES)[number]["code"];

/** DAY OUTING — the one type with a 6 PM in-time deadline. */
export const DAY_OUTING_CODE = "OG1";

/** Latest in-time permitted for a DAY OUTING. 18:00 itself is allowed. */
export const DAY_OUTING_LATEST_RETURN = "18:00";

/**
 * Maximum leave length in whole days, per type.
 *
 * VTOP enforces these server-side at submission and publishes NONE of them in
 * the form markup or in the leaveCode dropdown's response. A cap is listed
 * here ONLY where it has actually been observed being enforced:
 *
 *   HT1  14  confirmed by "Hometown duration should not exceed 14 days"
 *   WV   -  observed to accept a 17-day request
 *
 * Everything else is deliberately ABSENT rather than set to a large number.
 * "Unknown" must not become "no limit": inventing a cap for a type would reject
 * applications VTOP would have accepted, which is a worse failure than letting
 * VTOP decline one — a declined submission leaves no record behind.
 */
export const LEAVE_MAX_DAYS: Partial<Record<LeaveTypeCode, number>> = {
  HT1: 14,
};

/**
 * VIT Bhopal OD rule as reported by students (unconfirmed, Oct 2026):
 * about 8–9 event ODs; DSW-approved ODs are unlimited. Uses the lower bound.
 * (Upstream's Chennai rule was 40 hours per semester.)
 */
export const OD_EVENT_LIMIT = 8;
export const OD_RULE_NOTE =
  "VIT Bhopal rule as understood (unconfirmed): about 8-9 event ODs allowed; DSW-approved ODs are unlimited. " +
  "VTOP doesn't mark which ODs were DSW-approved, so every OD day is counted here. One OD day = one event day (all classes that day).";

/**
 * Messages for a missing / expired session.
 *
 * The recovery instructions are no longer hand-written prose: they are derived
 * from the error taxonomy in errors.ts, so the machine-readable `recovery`
 * array and the model-facing hint are generated from the same source and
 * cannot drift. Prefer throwing a VtopError over using these constants.
 */
export const NOT_AUTH_MSG = describeForModel(
  new VtopError("NOT_AUTHENTICATED", "No active VTOP session.").toBody(),
);

export const SESSION_EXPIRED_MSG = describeForModel(
  new VtopError("NOT_AUTHENTICATED", "VTOP session expired.").toBody(),
);

/** VIT course codes look like BCSE302L, BMGT105L, BFRE101L, etc. */
export const COURSE_CODE_PATTERN = /\b[A-Z]{3,5}\d{3,4}[A-Z]?\b/;

/** Grade letters VIT issues, in CGPA-descending order. */
export const GRADE_LETTERS = ["S", "A", "B", "C", "D", "E", "F", "N"] as const;
export type GradeLetter = (typeof GRADE_LETTERS)[number];

/** Numeric grade points per letter. F and N do not count toward GPA. */
export const GRADE_POINTS: Record<GradeLetter, number> = {
  S: 10,
  A: 9,
  B: 8,
  C: 7,
  D: 6,
  E: 5,
  F: 0,
  N: 0,
};
