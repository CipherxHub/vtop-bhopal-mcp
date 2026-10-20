import * as cheerio from "cheerio";
import type { Weekday, WeeklySchedule, CalendarDay } from "./attendance-calc.js";
import { VtopError } from "./errors.js";
import type {
  AttendanceRecord,
  TimetableSlot,
  MarksRecord,
  ExamSchedule,
  GradeRecord,
  GradeHistory,
  StudentProfile,
  Semester,
  CurriculumProgress,
  CurriculumProgressRow,
  GradeDistribution,
  ProfileSection,
  ProctorDetails,
  Acknowledgment,
  CurriculumBasket,
  CurriculumCourse,
  PendingSubject,
  CompletionDiscrepancy,
  FeeReceipt,
  FacultyMatch,
  FacultyDetail,
} from "../types/index.js";
import { GRADE_LETTERS, GRADE_POINTS } from "./constants.js";

/**
 * VTOP's recognised "genuinely empty" phrasings. When the expected container
 * is absent AND none of these appear, the page is a changed layout or an
 * error shell — which must throw UPSTREAM, never degrade to "nothing
 * published yet" with ok:true.
 */
const RECOGNISED_EMPTY = /no\s*(records?|data)\s*(found|to\s*(show|display))?/i;

function assertPageShape(found: boolean, what: string, html: string): void {
  if (found || RECOGNISED_EMPTY.test(html)) return;
  throw new VtopError(
    "UPSTREAM",
    `VTOP returned a ${what} page without the expected table.`,
    "The portal layout may have changed, or this is an error page. Not treated as empty data.",
  );
}

/**
 * Compute creditsRemaining (clamped ≥ 0) and percentComplete (rounded to
 * 1 decimal) for a curriculum row. Shared by every place we build a
 * CurriculumProgressRow or the top-level totals.
 */
function progressMetrics(
  required: number,
  earned: number
): { creditsRemaining: number; percentComplete: number } {
  return {
    creditsRemaining: Math.max(0, required - earned),
    percentComplete:
      required > 0
        ? Math.round((earned / required) * 1000) / 10
        : earned > 0
          ? 100
          : 0,
  };
}

/**
 * Locate and parse the post-login CGPA summary table whose header row is
 * `Credits Registered | Credits Earned | CGPA | S Grades | A Grades | ...`.
 * Used by both grade-history and curriculum-progress parsers.
 */
function parseCgpaSummary(
  $: cheerio.CheerioAPI
): {
  creditsRegistered: number;
  creditsEarned: number;
  cgpa: number;
  gradeDistribution: GradeDistribution;
} | null {
  const empty: GradeDistribution = {
    S: 0,
    A: 0,
    B: 0,
    C: 0,
    D: 0,
    E: 0,
    F: 0,
    N: 0,
  };
  const tables = $("table");
  for (let i = tables.length - 1; i >= 0; i--) {
    const $table = $(tables[i]);
    const headerRow = $table.find("tr").first();
    // Bhopal and Chennai disagree on th vs td headers; read both.
    const headerCells = headerRow.find("td, th");
    const headerText = headerRow.text().toLowerCase();
    if (!headerText.includes("credits") || !headerText.includes("cgpa")) {
      continue;
    }
    const headers: string[] = headerCells
      .map((_j, el) => $(el).text().trim().toLowerCase())
      .get();
    const valueCells = $table.find("td").slice(headerCells.length);
    const get = (predicate: (h: string) => boolean): number => {
      const idx = headers.findIndex(predicate);
      if (idx < 0 || idx >= valueCells.length) return 0;
      return parseFloat($(valueCells[idx]).text().trim()) || 0;
    };
    const gradeDistribution: GradeDistribution = { ...empty };
    for (const L of GRADE_LETTERS) {
      gradeDistribution[L] = get((h) => h.startsWith(L.toLowerCase() + " grade"));
    }
    return {
      creditsRegistered: get((h) => h.includes("credits registered")),
      creditsEarned: get((h) => h.includes("credits earned") || h.includes("earned")),
      cgpa: get((h) => h === "cgpa"),
      gradeDistribution,
    };
  }
  return null;
}

/**
 * Parse semester dropdown from the timetable page.
 * Android app: doc.getElementById('semesterSubId').getElementsByTagName('option')
 */
export function parseSemesters(html: string): Semester[] {
  const $ = cheerio.load(html);
  const semesters: Semester[] = [];

  $("#semesterSubId option, select option").each((_i, el) => {
    const id = $(el).attr("value")?.trim();
    const name = $(el).text().trim();
    if (id && name) {
      semesters.push({ id, name });
    }
  });

  return semesters;
}

/**
 * Parse attendance from VTOP HTML.
 *
 * Android app: table = doc.getElementById('getStudentDetails')
 * Columns by heading: 'course type', 'slot', 'attended', 'total', 'percentage'
 */
export function parseAttendance(html: string): AttendanceRecord[] {
  const $ = cheerio.load(html);
  const records: AttendanceRecord[] = [];

  // Chennai: table#getStudentDetails with <th> headers. Bhopal: div#getStudentDetails
  // wrapping a table whose header row is <td>s, with combined "Course Detail"
  // (code - title - type) and "Class Detail" (classId - slots - venue) columns.
  // Walk real <tr> rows: stepping a flat <td> list by header count looped forever
  // when there were no <th>s (colCount 0).
  const root = $("#getStudentDetails").first();
  const table = root.is("table") ? root : root.find("table").first();
  assertPageShape(table.length > 0, "attendance", html);

  const rows = table.find("tr").toArray();
  if (!rows.length) return records;
  const headings = $(rows[0])
    .children("th,td")
    .toArray()
    .map((el) => $(el).text().replace(/\s+/g, " ").trim().toLowerCase());

  const courseDetailIdx = headings.findIndex((h) => h.includes("course detail"));
  const classDetailIdx = headings.findIndex((h) => h.includes("class detail"));
  const courseCodeIdx = headings.findIndex((h) => h.includes("code"));
  const courseNameIdx = headings.findIndex(
    (h) =>
      h.includes("title") ||
      (h.includes("course") && !h.includes("type") && !h.includes("code"))
  );
  const courseTypeIdx = headings.findIndex(
    (h) => h.includes("course") && h.includes("type")
  );
  const slotIdx = headings.findIndex((h) => h.includes("slot"));
  const attendedIdx = headings.findIndex((h) => h.includes("attended"));
  const totalIdx = headings.findIndex((h) => h.includes("total"));
  const percentageIdx = headings.findIndex((h) => h.includes("percentage"));

  for (const row of rows.slice(1)) {
    const cells = $(row).children("td").toArray();
    if (cells.length !== headings.length) continue;
    const cell = (idx: number) =>
      idx >= 0 ? $(cells[idx]).text().replace(/\s+/g, " ").trim() : "";

    let courseCode = cell(courseCodeIdx);
    let courseName = cell(courseNameIdx);
    let courseType = cell(courseTypeIdx);
    if (courseCodeIdx < 0 && courseDetailIdx >= 0) {
      const parts = cell(courseDetailIdx).split(" - ");
      courseCode = parts[0].trim();
      courseType = parts.length >= 3 ? parts[parts.length - 1].trim() : "";
      courseName = parts.slice(1, parts.length >= 3 ? -1 : undefined).join(" - ").trim();
    }

    let slot = slotIdx >= 0 ? cell(slotIdx).split("+")[0].trim() : "";
    if (!slot && classDetailIdx >= 0) {
      slot = (cell(classDetailIdx).split(" - ")[1] ?? "").split("+")[0].trim();
    }
    if (!slot && !courseCode) continue;

    // A missing/non-numeric cell ("-", blank) is unknown, never 0. A real 0
    // means classes happened and none were attended; null means the figures
    // are not on the page, and every consumer must say so.
    const num = (s: string): number | null => {
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : null;
    };

    records.push({
      courseCode,
      courseName,
      courseType,
      slot,
      attended: num(cell(attendedIdx)),
      total: num(cell(totalIdx)),
      percentage: num(cell(percentageIdx)),
    });
  }

  return records;
}

/**
 * Parse courses from processViewTimeTable response.
 *
 * Android app: doc.getElementById('studentDetailsList').getElementsByTagName('table')[0]
 * Columns: 'course' (code-title(type)), 'l t p j c' (credits), 'slot' (slot-venue), 'faculty'
 */
export function parseCourses(
  html: string
): {
  code: string;
  title: string;
  type: string;
  credits: number;
  slots: string[];
  venue: string;
  faculty: string;
}[] {
  const $ = cheerio.load(html);
  const courses: {
    code: string;
    title: string;
    type: string;
    credits: number;
    slots: string[];
    venue: string;
    faculty: string;
  }[] = [];

  const container = $("#studentDetailsList");
  const table = container.find("table").first();
  assertPageShape(table.length > 0, "timetable course list", html);

  const headings: string[] = [];
  table.find("th").each((_i, el) => {
    headings.push($(el).text().trim().toLowerCase());
  });

  const courseIdx = headings.findIndex((h) => h === "course");
  const creditsIdx = headings.findIndex(
    (h) => h.includes("l t p j c") || h === "c"
  );
  const slotVenueIdx = headings.findIndex((h) => h.includes("slot"));
  const facultyIdx = headings.findIndex((h) => h.includes("faculty"));

  const cells = table.find("td");
  const colCount = headings.length;
  if (!colCount) return courses; // no <th> headers: stepping by 0 would never end

  for (let i = 0; i + colCount <= cells.length; i += colCount) {
    const cellText = (idx: number) =>
      idx >= 0
        ? $(cells[i + idx])
            .text()
            .trim()
            .replace(/\t/g, "")
            .replace(/\n/g, " ")
        : "";

    const rawCourse = cellText(courseIdx);
    if (!rawCourse) continue;

    const rawCourseType = rawCourse.split("(").slice(-1)[0].toLowerCase();
    const rawCredits = cellText(creditsIdx).trim().split(/\s+/);
    const rawSlotVenue = cellText(slotVenueIdx).split("-");
    const rawFaculty = cellText(facultyIdx).split("-");

    courses.push({
      code: rawCourse.split("-")[0].trim(),
      title: rawCourse.split("-").slice(1).join("-").split("(")[0].trim(),
      type: rawCourseType.includes("lab")
        ? "lab"
        : rawCourseType.includes("project")
          ? "project"
          : "theory",
      credits: parseInt(rawCredits[rawCredits.length - 1], 10) || 0,
      slots: rawSlotVenue[0].trim().split("+"),
      venue: rawSlotVenue.slice(1).join(" - ").trim(),
      faculty: rawFaculty[0].trim(),
    });
  }

  return courses;
}

/**
 * Parse timetable from processViewTimeTable response.
 * Returns courses with their slot/venue/faculty info as structured data.
 *
 * The page carries TWO tables: a course list (code/title/faculty/credits) and a
 * weekly day×time grid (which day, which slot, what times). This function used
 * to return only the course list and hardcode day/startTime/endTime to "", so
 * `get_timetable` advertised those fields but never filled them. It now merges
 * the grid in: `sessions` lists every weekly meeting, and the scalar
 * day/startTime/endTime mirror the FIRST session so single-slot consumers keep
 * working.
 */
export function parseTimetable(html: string): TimetableSlot[] {
  const courses = parseCourses(html);

  // Grid sessions grouped per course. A course with two slots a week appears in
  // the grid twice, so this is a list, not a single value.
  const byCourse = new Map<string, GridSession[]>();
  for (const s of parseTimetableGrid(html)) {
    const list = byCourse.get(s.courseCode);
    if (list) list.push(s);
    else byCourse.set(s.courseCode, [s]);
  }

  return courses.map((c) => {
    const sessions = byCourse.get(c.code) ?? [];
    const first = sessions[0];
    return {
      day: first?.day ?? "",
      startTime: first?.startTime ?? "",
      endTime: first?.endTime ?? "",
      courseCode: c.code,
      courseName: c.title,
      courseType: c.type,
      venue: c.venue,
      faculty: c.faculty,
      slots: c.slots.join("+"),
      credits: c.credits,
      sessions: sessions.map((s) => ({
        day: s.day,
        slot: s.slot,
        type: s.type,
        startTime: s.startTime,
        endTime: s.endTime,
        venue: s.venue,
      })),
    };
  });
}

export interface GridSession {
  day: Weekday;
  slot: string;
  courseCode: string;
  venue: string;
  startTime: string;
  endTime: string;
  type: "THEORY" | "LAB";
}

const GRID_WEEKDAYS: Record<string, Weekday> = {
  SUN: "SUN", MON: "MON", TUE: "TUE", WED: "WED", THU: "THU", FRI: "FRI", SAT: "SAT",
};

/**
 * Parse the weekly day×time grid out of the processViewTimeTable HTML.
 *
 * The grid is paired rows per day: a THEORY row (first cell = weekday, second =
 * "THEORY") followed by a LAB row (first cell = "LAB"). Period start/end times
 * live in four header rows (THEORY Start/End, LAB Start/End). Occupied cells are
 * "SLOT-COURSECODE" (e.g. "A1-BCSE302L"); empty/free slots are bare codes or "-".
 * Each occupied cell is one weekly session of that course.
 */
export function parseTimetableGrid(html: string): GridSession[] {
  const $ = cheerio.load(html);
  // The grid is the table that has a row whose first cell is a weekday (the
  // course-list table never does), so detect that rather than matching against
  // concatenated cell text.
  const gridEl = $("table").toArray().find((t) =>
    $(t)
      .find("tr")
      .toArray()
      .some((r) => GRID_WEEKDAYS[$(r).find("td, th").first().text().trim().toUpperCase()] !== undefined),
  );
  if (!gridEl) {
    assertPageShape(false, "timetable grid", html);
    return [];
  }
  const grid = $(gridEl);
  const tbodyRows = grid.find("> tbody > tr");
  const rows = (tbodyRows.length ? tbodyRows : grid.find("tr")).toArray();
  const rowCells = (r: (typeof rows)[number]) =>
    $(r).find("td, th").map((_j, e) => $(e).text().replace(/\s+/g, " ").trim()).get();

  let theoryStart: string[] = [], theoryEnd: string[] = [], labStart: string[] = [], labEnd: string[] = [];
  const sessions: GridSession[] = [];
  let currentDay: Weekday | null = null;

  const addSlots = (
    slotCells: string[], starts: string[], ends: string[],
    type: "THEORY" | "LAB", day: Weekday,
  ) => {
    for (let i = 0; i < slotCells.length; i++) {
      const cell = slotCells[i];
      if (!cell || /^lunch$/i.test(cell) || cell === "-") continue;
      // Occupied cell: "SLOT-COURSE-TYPE-VENUE-GROUP", e.g. "A1-BCSE302L-TH-AB3-205-ALL"
      // (venue itself can contain a dash). Bare slots like "A2" have no course.
      const parts = cell.split("-").map((s) => s.trim());
      if (parts.length < 2) continue;
      const slot = parts[0];
      const courseCode = parts[1];
      if (!/^[A-Z]{3,5}\d{3,4}[A-Z]?$/.test(courseCode)) continue;
      const venue = parts.length >= 5 ? parts.slice(3, -1).join("-") : "";
      sessions.push({ day, slot, courseCode, venue, startTime: starts[i] ?? "", endTime: ends[i] ?? "", type });
    }
  };

  for (const r of rows) {
    const cells = rowCells(r);
    if (!cells.length) continue;
    const c0 = (cells[0] ?? "").toUpperCase();
    const c1 = (cells[1] ?? "").toUpperCase();

    if (c0 === "THEORY" && c1 === "START") { theoryStart = cells.slice(2); continue; }
    if (c0 === "LAB" && c1 === "START") { labStart = cells.slice(2); continue; }
    if (c0 === "END") {
      if (!theoryEnd.length) theoryEnd = cells.slice(1);
      else labEnd = cells.slice(1);
      continue;
    }
    if (GRID_WEEKDAYS[c0]) {
      currentDay = GRID_WEEKDAYS[c0];
      addSlots(cells.slice(2), theoryStart, theoryEnd, "THEORY", currentDay);
      continue;
    }
    if (c0 === "LAB" && currentDay) {
      addSlots(cells.slice(1), labStart, labEnd, "LAB", currentDay);
    }
  }
  return sessions;
}

/** Group grid sessions into a per-weekday list of course codes (repeats = multiple sessions). */
export function weeklyScheduleFromGrid(sessions: GridSession[]): WeeklySchedule {
  const sched: WeeklySchedule = { SUN: [], MON: [], TUE: [], WED: [], THU: [], FRI: [], SAT: [] };
  for (const s of sessions) sched[s.day].push(s.courseCode);
  return sched;
}

export interface AttendanceDetailRef {
  courseCode: string;
  courseName: string;
  classId: string;
  slot: string;
  /** POST params for processViewAttendanceDetail (differ per campus). */
  params: Record<string, string>;
}

/**
 * From the main attendance page, extract per-course handles for the per-class
 * detail view. Each row's "View" control carries
 * processViewAttendanceDetail('<classId>','<slot>').
 */
export function parseAttendanceDetailRefs(html: string): AttendanceDetailRef[] {
  // Chennai: processViewAttendanceDetail('<classId>','<slot>').
  // Bhopal:  callStudentAttendanceDetailDisplay('<sem>','<regNo>','<courseId>','<type>'),
  //          with code/title combined in a "Course Detail" cell.
  const $ = cheerio.load(html);
  const SEL = "[onclick*='processViewAttendanceDetail'],[onclick*='callStudentAttendanceDetailDisplay']";
  const tableEl = $("table")
    .toArray()
    .find((t) => $(t).find(SEL).length > 0);
  if (!tableEl) return [];
  const table = $(tableEl);
  // Use all rows (the table has a <thead> header + <tbody> data); the header is
  // the first row and data rows are the ones carrying the detail onclick.
  const allRows = table.find("tr").toArray();
  const headers = $(allRows[0])
    .find("td, th")
    .map((_i, e) => $(e).text().replace(/\s+/g, " ").trim().toLowerCase())
    .get();
  const codeIdx = headers.findIndex((h) => h.includes("course") && h.includes("code"));
  const nameIdx = headers.findIndex((h) => h.includes("course") && (h.includes("title") || h.includes("name")));
  const detailIdx = headers.findIndex((h) => h.includes("course detail"));
  const classIdx = headers.findIndex((h) => h.includes("class detail"));
  const Q = "(?:&#39;|['\"])([^'\"&]*)(?:&#39;|['\"])";
  const chennaiRe = new RegExp(`processViewAttendanceDetail\\(${Q}\\s*,\\s*${Q}`);
  const bhopalRe = new RegExp(`callStudentAttendanceDetailDisplay\\(\\s*${Q}\\s*,\\s*${Q}\\s*,\\s*${Q}\\s*,\\s*${Q}`);

  const refs: AttendanceDetailRef[] = [];
  for (const r of allRows) {
    const oc = $(r).find(SEL).attr("onclick") ?? "";
    const cells = $(r).children("td").map((_j, e) => $(e).text().replace(/\s+/g, " ").trim()).get();
    const cell = (idx: number) => (idx >= 0 && idx < cells.length ? cells[idx] : "");
    const c = oc.match(chennaiRe);
    if (c) {
      refs.push({
        courseCode: cell(codeIdx), courseName: cell(nameIdx), classId: c[1], slot: c[2],
        params: { classId: c[1], slotName: c[2] },
      });
      continue;
    }
    const b = oc.match(bhopalRe);
    if (!b) continue;
    const detail = cell(detailIdx).split(" - ");
    refs.push({
      courseCode: codeIdx >= 0 ? cell(codeIdx) : detail[0].trim(),
      courseName: nameIdx >= 0 && detailIdx < 0 ? cell(nameIdx) : (detail[1] ?? "").trim(),
      classId: b[3],
      slot: (cell(classIdx).split(" - ")[1] ?? "").split("+")[0].trim(),
      params: { semesterSubId: b[1], registerNumber: b[2], courseId: b[3], courseType: b[4] },
    });
  }
  return refs;
}

export interface AttendanceDetailCounts {
  present: number;
  absent: number;
  onDuty: number;
  total: number;
  /**
   * Rows with a non-empty but unrecognised status (Holiday, Cancelled…).
   * Counted separately so present+absent+onDuty+other always equals total.
   */
  other: number;
  /** OD time in class-hours (duration-based: a 2-period lab counts as 2). */
  odHours: number;
  /** Date cell of each OD class, as VTOP shows it (e.g. "25-09-2026"). */
  odDates: string[];
}

/** "08:00", "08:00 AM", "01:40 PM" -> minutes since midnight, or null. */
function clockToMinutes(token: string): number | null {
  const m = token.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let h = +m[1];
  const min = +m[2];
  const ap = m[3]?.toUpperCase();
  if (ap === "PM" && h !== 12) h += 12;
  else if (ap === "AM" && h === 12) h = 0;
  return h * 60 + min;
}

/**
 * How many ~50-minute class periods a "Day And Timing" cell spans (a 2-period
 * lab counts as 2). VTOP writes timings in either 24-hour ("14:00-15:40") or
 * 12-hour ("02:00 PM - 03:40 PM") form, and each end may carry its own AM/PM,
 * so we parse both clock tokens independently. A 12-hour pair that crosses noon
 * without an explicit PM on the end (e.g. "11:00-01:40") yields a negative span;
 * we add 12h to recover it rather than silently undercounting to one period.
 */
function periodsFromTiming(timing: string): number {
  const tokens = timing.match(/\d{1,2}:\d{2}\s*(?:AM|PM)?/gi);
  if (!tokens || tokens.length < 2) return 1;
  const start = clockToMinutes(tokens[0]);
  const end = clockToMinutes(tokens[tokens.length - 1]);
  if (start == null || end == null) return 1;
  let dur = end - start;
  if (dur < 0) dur += 12 * 60;
  return dur <= 0 ? 1 : Math.max(1, Math.round(dur / 50));
}

/**
 * Parse a per-class attendance detail (processViewAttendanceDetail) and tally
 * statuses. Row-level data lives in parseAttendanceDetailRows below; the
 * get_attendance_detail tool posts to this endpoint (Bhopal request shape
 * still fails loud via hasAttendanceDetailTable until verified live).
 */

/** One per-class attendance row: a single class session and its outcome. */
export interface AttendanceDetailRow {
  /** ISO YYYY-MM-DD when the printed date parses, else verbatim. */
  date: string;
  /** Day-and-timing cell verbatim (e.g. "MON,08:00-08:50"). May be "". */
  timing: string;
  /** Status verbatim as VTOP prints it (Present / Absent / On Duty / …). */
  status: string;
  /** Normalised bucket: present | absent | on-duty | unknown. */
  marker: "present" | "absent" | "on-duty" | "unknown";
}

const DETAIL_MONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

/** Detail dates print as DD-MMM-YYYY ("01-Jan-2026") or DD-MM-YYYY ("25-09-2026"). */
export function normaliseDetailDate(raw: string): string {
  const s = (raw ?? "").trim();
  let m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (m) {
    const mo = DETAIL_MONTHS[m[2].toUpperCase()];
    if (mo) return `${m[3]}-${mo}-${m[1].padStart(2, "0")}`;
  }
  m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return s;
}

/** Locate the per-class detail table and its column indices, if present. */
function detailTable($: cheerio.CheerioAPI): {
  rows: ReturnType<cheerio.CheerioAPI>;
  statusIdx: number;
  timingIdx: number;
  dateIdx: number;
} | null {
  // The per-class table: the longest one whose header row has date + status
  // columns. Bhopal puts a one-row course-summary table (also date/status
  // headers) first, and the per-class header in <thead>.
  const headerOf = (t: Parameters<typeof $>[0]) =>
    $(t).find("tr").first().find("td, th").text().toLowerCase();
  const candidates = $("table")
    .toArray()
    .filter((t) => /date/.test(headerOf(t)) && /status/.test(headerOf(t)))
    .sort((a, b) => $(b).find("tr").length - $(a).find("tr").length);
  // No fallback to the first table: an unrelated table would parse its last
  // cells as statuses and fabricate rows. Absence means absence.
  const tableEl = candidates[0];
  if (!tableEl) return null;
  const rows = $(tableEl).find("tr");
  const headers = $(rows[0])
    .find("td, th")
    .map((_i, e) => $(e).text().replace(/\s+/g, " ").trim().toLowerCase())
    .get();
  return {
    rows,
    statusIdx: headers.findIndex((h) => h.includes("status")),
    timingIdx: headers.findIndex((h) => h.includes("timing") || (h.includes("day") && h.includes("time"))),
    dateIdx: headers.findIndex((h) => h.includes("date")),
  };
}

/** True when the HTML carries a per-class detail table at all. */
export function hasAttendanceDetailTable(html: string): boolean {
  const $ = cheerio.load(html);
  return detailTable($) !== null;
}

function detailMarker(status: string): AttendanceDetailRow["marker"] {
  const s = status.toLowerCase();
  if (/on\s*duty/.test(s)) return "on-duty";
  if (/present/.test(s)) return "present";
  if (/absent/.test(s)) return "absent";
  return "unknown";
}

/**
 * Per-class attendance rows (processViewAttendanceDetail response): one entry
 * per class session with its date and outcome. A date with no row means VTOP
 * has posted nothing for it — "not posted", never "absent".
 */
export function parseAttendanceDetailRows(html: string): AttendanceDetailRow[] {
  const $ = cheerio.load(html);
  const found = detailTable($);
  if (!found) return [];
  const out: AttendanceDetailRow[] = [];
  found.rows.slice(1).each((_i, r) => {
    const cells = $(r).find("td").map((_j, e) => $(e).text().replace(/\s+/g, " ").trim()).get();
    if (cells.length === 0) return;
    const status = found.statusIdx >= 0 ? cells[found.statusIdx] : cells[cells.length - 1] ?? "";
    if (!status) return;
    out.push({
      date: normaliseDetailDate(found.dateIdx >= 0 ? (cells[found.dateIdx] ?? "") : ""),
      timing: found.timingIdx >= 0 ? (cells[found.timingIdx] ?? "") : "",
      status,
      marker: detailMarker(status),
    });
  });
  return out;
}

export function parseAttendanceDetail(html: string): AttendanceDetailCounts {
  const $ = cheerio.load(html);
  const found = detailTable($);
  const counts: AttendanceDetailCounts = { present: 0, absent: 0, onDuty: 0, total: 0, other: 0, odHours: 0, odDates: [] };
  if (!found) return counts;
  found.rows.slice(1).each((_i, r) => {
    const cells = $(r).find("td").map((_j, e) => $(e).text().replace(/\s+/g, " ").trim()).get();
    if (cells.length === 0) return;
    const status = (found.statusIdx >= 0 ? cells[found.statusIdx] : cells[cells.length - 1] ?? "").toLowerCase();
    if (!status) return;
    counts.total++;
    if (/on\s*duty/.test(status)) {
      counts.onDuty++;
      counts.odHours += periodsFromTiming(found.timingIdx >= 0 ? cells[found.timingIdx] ?? "" : "");
      if (found.dateIdx >= 0 && cells[found.dateIdx]) counts.odDates.push(cells[found.dateIdx]);
    } else if (/present/.test(status)) counts.present++;
    else if (/absent/.test(status)) counts.absent++;
    else counts.other++;
  });
  return counts;
}

const MONTH_NUM: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};
const DAY_ORDER_NAME: Record<string, Weekday> = {
  SUNDAY: "SUN", MONDAY: "MON", TUESDAY: "TUE", WEDNESDAY: "WED",
  THURSDAY: "THU", FRIDAY: "FRI", SATURDAY: "SAT",
};
const pad2 = (n: number) => String(n).padStart(2, "0");

/** "01-DEC-2025" -> "2025-12" (sortable month key) for range filtering. */
export function calDateMonthKey(calDate: string): string {
  const [, mon, yr] = calDate.split("-");
  const m = MONTH_NUM[(mon ?? "").toUpperCase()];
  return m ? `${yr}-${pad2(m)}` : "";
}

/** Extract the month buttons' calDate values (e.g. "01-DEC-2025") from the getListForSemester response. */
export function parseCalendarMonths(html: string): string[] {
  return [...new Set(
    [...html.matchAll(/processViewCalendar\([^)]*?(\d{2}-[A-Z]{3}-\d{4})/g)].map((m) => m[1]),
  )];
}

/**
 * Parse one month's academic-calendar table (the processViewCalendar response).
 * `calDate` is that month's token, e.g. "01-DEC-2025", used to date each cell.
 *
 * Each day cell's spans are [dayNumber, info, detail, ...repeated per program].
 * A day is instructional when the first info span starts with "Instructional Day"
 * ("No Instructional Day" is excluded). A working Saturday etc. carries a
 * "<Weekday> Day Order" note in a detail span telling which timetable it follows.
 */
export function parseAcademicCalendar(html: string, calDate: string): CalendarDay[] {
  const [, mon, yr] = calDate.split("-");
  const monthNum = MONTH_NUM[(mon ?? "").toUpperCase()];
  const year = parseInt(yr ?? "", 10);
  // A bad token is a caller bug, not an empty month — fail loud so a
  // corrupted calendar can never read as "no instructional days".
  if (!monthNum || !Number.isFinite(year)) {
    throw new VtopError(
      "UPSTREAM",
      `Cannot parse the calendar month token "${calDate}".`,
      "Expected DD-MMM-YYYY (e.g. 01-DEC-2025) from the month list.",
    );
  }

  const $ = cheerio.load(html);
  const table = $("table.calendar-table").first().length
    ? $("table.calendar-table").first()
    : $("#list-wrapper table").first();
  assertPageShape(table.length > 0, "academic calendar month", html);

  const days: CalendarDay[] = [];
  table.find("td").each((_i, td) => {
    const spans = $(td).find("span").map((_j, s) => $(s).text().replace(/\s+/g, " ").trim()).get();
    if (!spans.length) return;
    const day = parseInt(spans[0], 10);
    if (!Number.isFinite(day) || day < 1 || day > 31) return;

    const info = spans[1] ?? "";
    const instructional = /^instructional day/i.test(info);
    const joined = spans.join(" ");

    // Event/holiday text is the parenthesised "detail" span after each program's
    // status. Take only the first program's (the one `instructional` reads:
    // Bhopal "General", listed first) — merging all of them mixed in other
    // groups' events (Freshers/BArch "Last Instructional Day" on a General exam day).
    const detail = spans[2] ?? "";
    const label = /^\(/.test(detail) ? detail.replace(/^\(|\)$/g, "").trim() : "";
    // Which weekday's timetable the day follows: Chennai "Thursday Day Order";
    // Bhopal "Remote Learning - Class/CAM Activities Friday" (first program only).
    const WD = "(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)";
    const m =
      joined.match(new RegExp(`${WD}\\s+Day Order`, "i")) ??
      label.match(new RegExp(`Activities\\s+${WD}\\b`, "i"));
    const dayOrderWeekday = m ? DAY_ORDER_NAME[m[1].toUpperCase()] : null;

    days.push({
      date: `${year}-${pad2(monthNum)}-${pad2(day)}`,
      instructional,
      dayOrderWeekday: instructional ? (dayOrderWeekday ?? null) : null,
      label,
    });
  });
  return days;
}

/**
 * Parse marks from examinations/doStudentMarkView response.
 *
 * Android app: table = doc.getElementById('fixedTableContainer')
 * Outer rows: course type + slot. Next row: inner table with mark components.
 */
export function parseMarks(html: string): MarksRecord[] {
  const $ = cheerio.load(html);
  const records: MarksRecord[] = [];

  if (html.toLowerCase().includes("no data found")) return records;

  // #fixedTableContainer is a <div> that wraps the marks <table.customTable>.
  const container = $("#fixedTableContainer").first();
  if (!container.length) return records;
  const table = container.is("table") ? container : container.find("table").first();
  if (!table.length) return records;

  // Direct rows only (htmlparser2 doesn't auto-insert <tbody>).
  const tbody = table.children("tbody");
  const rows = tbody.length ? tbody.children("tr") : table.children("tr");
  if (!rows.length) return records;

  // Outer heading row → column indices for the per-course summary row.
  const headings: string[] = [];
  $(rows[0])
    .find("> td, > th")
    .each((_i, el) => {
      headings.push($(el).text().trim().toLowerCase());
    });
  const courseCodeIdx = headings.findIndex((h) => h.includes("course") && h.includes("code"));
  const courseTitleIdx = headings.findIndex(
    (h) => h.includes("course") && (h.includes("title") || h.includes("name"))
  );
  const courseTypeIdx = headings.findIndex((h) => h.includes("course") && h.includes("type"));
  // "Course Mode" carries the LTM / LPM / LTPM code that decides which
  // assessment components a course is expected to have.
  const courseModeIdx = headings.findIndex((h) => h.includes("mode"));
  const slotIdx = headings.findIndex((h) => h.includes("slot"));

  // Rows alternate: [course summary row] then [row holding the nested marks
  // table]. Walk summary rows and look ahead one row for the marks table.
  for (let i = 1; i < rows.length; i++) {
    const row = $(rows[i]);
    if (row.find("table").length) continue; // nested-table row — consumed below
    const cells = row.find("> td");
    if (cells.length < 2) continue;
    const cell = (idx: number) =>
      idx >= 0 && idx < cells.length ? $(cells[idx]).text().trim() : "";

    const record: MarksRecord = {
      courseCode: cell(courseCodeIdx),
      courseName: cell(courseTitleIdx),
      courseType: cell(courseTypeIdx),
      courseMode: cell(courseModeIdx).toUpperCase(),
      slot: cell(slotIdx).split("+")[0].trim(),
      marks: [],
    };

    const innerTable = i + 1 < rows.length ? $(rows[i + 1]).find("table").first() : $();
    if (innerTable.length) {
      const innerRows = innerTable.find("tr");
      const ih: string[] = [];
      $(innerRows[0])
        .find("td, th")
        .each((_j, el) => {
          ih.push($(el).text().trim().toLowerCase());
        });
      const titleIdx = ih.findIndex((h) => h.includes("title"));
      const maxIdx = ih.findIndex((h) => h.includes("max") && !h.includes("weightage"));
      const scoredIdx = ih.findIndex((h) => h.includes("scored"));
      const weightageIdx = ih.findIndex((h) => h.includes("weightage") && h.includes("mark"));
      const maxWeightageIdx = ih.findIndex((h) => h.includes("%"));
      const averageIdx = ih.findIndex((h) => h.includes("average"));
      const statusIdx = ih.findIndex((h) => h.includes("status"));

      for (let j = 1; j < innerRows.length; j++) {
        const ic = $(innerRows[j]).find("td");
        const c = (idx: number) => (idx >= 0 && idx < ic.length ? $(ic[idx]).text().trim() : "");
        const title = c(titleIdx);
        if (!title) continue;
        // Blank cells are unpublished, never 0: a missing Scored must read as
        // "not yet scored", not as a scored zero that depresses totals.
        const f = (s: string): number | null => {
          const n = parseFloat(s);
          return Number.isFinite(n) ? n : null;
        };
        record.marks.push({
          component: title,
          maxMarks: f(c(maxIdx)),
          scored: f(c(scoredIdx)),
          maxWeightage: f(c(maxWeightageIdx)),
          weightage: f(c(weightageIdx)),
          average: parseFloat(c(averageIdx)) || null,
          status: c(statusIdx),
        });
      }
    }

    if (record.courseCode || record.marks.length > 0) records.push(record);
  }

  return records;
}

/**
 * Parse exam schedule from examinations/doSearchExamScheduleForStudent.
 *
 * Android app: Columns by heading: slot, date, exam time, venue, location, seat no.
 * Exam type headers span multiple columns (colSpan > 1).
 */
// --- hostel leave ----------------------------------------------------------

export interface LeaveTypeOption {
  code: string;
  label: string;
}

export interface LeaveRecord {
  /** VTOP's leave id, e.g. L1234567. Null when VTOP published none. */
  leaveId: string | null;
  visitPlace: string;
  reason: string;
  leaveType: string;
  /** Verbatim as VTOP prints it ("30-OCT-2026 17:00"), not ISO-normalised. */
  from: string;
  to: string;
  /** Verbatim status, e.g. REQUEST APPROVED / HOSTEL APPROVAL PENDING. */
  status: string;
  remarks: string;
  /** Gate-pass icons, only present on the history view. Null = not shown. */
  gatePassOut: boolean | null;
  gatePassIn: boolean | null;
}

/**
 * Leave types offered by the leaveCode dropdown, read from the live form rather
 * than assumed. VTOP can add or retire a type without notice, so the tool shows
 * what the portal actually offers instead of a hard-coded list.
 */
export function parseLeaveTypeOptions(html: string): LeaveTypeOption[] {
  const $ = cheerio.load(html);
  const out: LeaveTypeOption[] = [];
  $("select#leaveCode option, select[name='leaveCode'] option").each((_, el) => {
    const code = ($(el).attr("value") ?? "").trim();
    const label = $(el).text().replace(/\s+/g, " ").trim();
    if (!code) return; // the "-Select-" placeholder
    out.push({ code, label });
  });
  return out;
}

/**
 * Leave rows from the status or history table.
 *
 * Both views share a shape (Leave Id, Visit Place, Reason, Leave Type, From,
 * To, Status, Remarks); history adds gate-pass columns. Columns are located by
 * header text rather than position, because Bhopal's two views disagree on
 * whether "Leave Id" leads.
 */
export function parseLeaveRecords(html: string): LeaveRecord[] {
  const $ = cheerio.load(html);
  const out: LeaveRecord[] = [];
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const text = (el: unknown) => clean($(el as never).text());

  const rows = $("tr").toArray();

  // Locate the header row by its labels. The two views disagree on column order,
  // so every field is resolved by header text rather than index.
  let head: string[] = [];
  for (const r of rows) {
    const cells = $(r).children("td,th").toArray();
    if (cells.length < 3) continue;
    const labels = cells.map((c) => text(c).toLowerCase());
    if (labels.some((l) => l.includes("leave id")) && labels.some((l) => l.includes("status"))) {
      head = labels;
      break;
    }
  }
  // No recognisable header means no table to read (e.g. "No Records To Show").
  if (head.length === 0) return out;

  const idx = (pred: (h: string) => boolean): number => head.findIndex(pred);

  for (const r of rows) {
    const cells = $(r).children("td").toArray();
    if (cells.length < 3) continue;
    const values = cells.map((c) => text(c));
    if (values.every((v) => v === "")) continue;

    const at = (pred: (h: string) => boolean): string => {
      const i = idx(pred);
      return i >= 0 && values[i] !== undefined ? values[i] : "";
    };
    // Gate-pass cells hold an icon, so presence of any element means issued.
    const gateAt = (pred: (h: string) => boolean): boolean | null => {
      const i = idx(pred);
      if (i < 0) return null;
      const cell = cells[i];
      if (!cell) return null;
      return $(cell).find("img, i, svg, .glyphicon").length > 0;
    };

    // A data row is identified by CONTENT, not position. Bhopal marks the
    // header with <td> as often as <th>, so "the row above the first data row"
    // is not a safe way to find it — and a positional guard happily parses the
    // header itself as a leave whose id is the literal text "Leave Id".
    const leaveId = at((h) => h.includes("leave id"));
    const status = at((h) => h.includes("status"));
    const looksLikeId = /^[A-Za-z]\d{3,}$/.test(leaveId);
    const looksLikeStatus = /approved|pending|rejected|cancel/i.test(status);
    if (!looksLikeId && !looksLikeStatus) continue;
    // Both columns still reading as their own header labels means this IS the
    // header, not a record.
    if (
      leaveId.trim().toLowerCase() === "leave id" &&
      status.trim().toLowerCase() === "status"
    ) {
      continue;
    }

    out.push({
      leaveId: leaveId || null,
      visitPlace: at((h) => h.includes("visit")),
      reason: at((h) => h.includes("reason")),
      leaveType: at((h) => h.includes("leave") && h.includes("type")),
      from: at((h) => h === "from" || h.startsWith("from ")),
      // "to" alone would also bind a "Total"/"Token" column: require the
      // bare header or a separator right after it.
      to: at((h) => h === "to" || h.startsWith("to ") || h.startsWith("to-")),
      status,
      remarks: at((h) => h.includes("remark")),
      // Headers are literally "Gate Pass OUT" / "Gate Pass IN". Match on both
      // words so a future "Checkout" column cannot be mistaken for a gate pass.
      gatePassOut: gateAt((h) => h.includes("gate") && h.includes("out")),
      gatePassIn: gateAt((h) => h.includes("gate") && h.includes("in")),
    });
  }

  return out;
}

/** A withdraw affordance VTOP renders for one leave row, if any. */
export interface LeaveCancelControl {
  leaveId: string;
  /** "href": plain link with query params. "onclick": JS call with args. */
  kind: "href" | "onclick";
  /** Link path or JS function name. */
  action: string;
  /** Query params (href) or positional args as arg0..argN (onclick). */
  params: Record<string, string>;
  /**
   * requestDataListUpdate buttons only: the data-* wiring the page's own JS
   * reads (control name, POST target, row parameters, row number). Absent for
   * every other control shape.
   */
  data?: {
    controlName: string;
    urlText: string;
    parameters: string[];
    rowNumber: string;
    /** data-formname when present; absent selects the page JS's TABLE branch. */
    formName: string | null;
  };
}

/**
 * Withdraw controls on the leave-status view. VTOP publishes no documented
 * cancel endpoint — when a row carries a cancel/withdraw link or button, its
 * target is read at runtime instead of guessed. Rows without one are not
 * cancellable through this path.
 */
export function parseLeaveCancelControls(html: string): LeaveCancelControl[] {
  const $ = cheerio.load(html);
  const out: LeaveCancelControl[] = [];
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const text = (el: unknown) => clean($(el as never).text());

  const rows = $("tr").toArray();
  let head: string[] = [];
  for (const r of rows) {
    const cells = $(r).children("td,th").toArray();
    if (cells.length < 3) continue;
    const labels = cells.map((c) => text(c).toLowerCase());
    if (labels.some((l) => l.includes("leave id")) && labels.some((l) => l.includes("status"))) {
      head = labels;
      break;
    }
  }
  if (head.length === 0) return out;
  const idIdx = head.findIndex((h) => h.includes("leave id"));

  for (const r of rows) {
    const cells = $(r).children("td").toArray();
    if (cells.length < 3) continue;
    const values = cells.map((c) => text(c));
    if (values.every((v) => v === "")) continue;
    const leaveId = idIdx >= 0 && values[idIdx] !== undefined ? values[idIdx] : "";
    if (!/^[A-Za-z]\d{3,}$/.test(leaveId)) continue;

    const spots = $(r).find("a, button, input[type=button], input[type=submit]").toArray();
    for (const el of spots) {
      const $el = $(el as never);
      const label = clean(
        `${$el.text()} ${$el.attr("value") ?? ""} ${$el.attr("title") ?? ""}`
      );
      const href = $el.attr("href") ?? "";
      const onclick = $el.attr("onclick") ?? "";
      if (
        !/cancel|withdraw/i.test(label) &&
        !/cancel|withdraw/i.test(href) &&
        !/cancel|withdraw/i.test(onclick)
      ) {
        continue;
      }
      // Decide by the SCRIPT first: VTOP's own Cancel button is
      // `<a href="#" onclick="requestDataListUpdate(this)" data-…>`. Treating
      // that "#" as a link sent the withdraw to the portal root, so the
      // script-call path never fired.
      const fn = (onclick.match(/([A-Za-z_$][\w$]*)\s*\(/) ?? [])[1] ?? "";
      const isAnchorOnly =
        href === "" || href === "#" || href.startsWith("#") || href.startsWith("javascript:");
      if (fn === "requestDataListUpdate" || (href && !isAnchorOnly)) {
        if (fn === "requestDataListUpdate") {
          const args = [...onclick.matchAll(/['"]([^'"]*)['"]/g)].map((m) => m[1]);
          const params: Record<string, string> = {};
          args.forEach((a, i) => {
            params[`arg${i}`] = a;
          });
          const control: LeaveCancelControl = { leaveId, kind: "onclick", action: fn, params };
          // requestDataListUpdate(this) buttons carry their whole request in
          // data-* attributes — capture them so the confirm path replays the
          // page's own POST instead of guessing it.
          const rawParams = $el.attr("data-parameters") ?? "";
          control.data = {
            controlName: $el.attr("data-controlname") ?? "",
            urlText: $el.attr("data-urltext") ?? "",
            parameters: [...rawParams.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]),
            rowNumber: $el.attr("data-rownumber") ?? "",
            formName: $el.attr("data-formname") ?? null,
          };
          out.push(control);
          continue;
        }
        const [action, qs] = href.split("?", 2);
        const params: Record<string, string> = {};
        if (qs) {
          for (const [k, v] of new URLSearchParams(qs)) params[k] = v;
        }
        out.push({ leaveId, kind: "href", action, params });
      } else {
        const args = [...onclick.matchAll(/['"]([^'"]*)['"]/g)].map((m) => m[1]);
        const params: Record<string, string> = {};
        args.forEach((a, i) => {
          params[`arg${i}`] = a;
        });
        out.push({ leaveId, kind: "onclick", action: fn, params });
      }
    }
  }

  return out;
}

export function parseExamSchedule(html: string): ExamSchedule[] {
  const $ = cheerio.load(html);
  const schedules: ExamSchedule[] = [];

  // Genuine empty first: VTOP prints "No Records/Found" phrasings. A bare
  // "not found" substring matched course titles and boilerplate — never that.
  if (RECOGNISED_EMPTY.test(html)) return schedules;

  // Walk rows. The header row is the first one with a "Slot" cell (Bhopal puts a
  // "General (Semester)" row above it); single-cell rows are exam-type titles
  // (CAT-1 / FAT); full-width rows are exams.
  const rows = $("tr").toArray();
  const text = (el: Parameters<typeof $>[0]) => $(el).text().replace(/\s+/g, " ").trim();
  const headerAt = rows.findIndex((r) =>
    $(r).children("td,th").toArray().some((c) => text(c).toLowerCase() === "slot"),
  );
  if (headerAt < 0) {
    assertPageShape(false, "exam schedule", html);
    return schedules;
  }

  const headings = $(rows[headerAt])
    .children("td,th")
    .toArray()
    .map((c) => text(c).toLowerCase());
  const col = (pred: (h: string) => boolean) => headings.findIndex(pred);
  const codeIdx = col((h) => h.includes("code"));
  const titleIdx = col((h) => h.includes("title"));
  const slotIdx = col((h) => h.includes("slot"));
  const dateIdx = col((h) => h.includes("date"));
  const sessionIdx = col((h) => h.includes("session"));
  const timeIdx = col((h) => h.includes("exam") && h.includes("time"));
  const venueIdx = col((h) => h.includes("venue"));
  const locationIdx = col((h) => h.includes("location"));
  const seatIdx = col((h) => h.includes("seat") && h.includes("no"));

  let examTitle = "";
  for (const row of rows.slice(headerAt + 1)) {
    const cells = $(row).children("td,th").toArray();
    if (cells.length === 1) {
      examTitle = text(cells[0]);
      continue;
    }
    if (cells.length !== headings.length) continue;
    const cell = (idx: number) => (idx >= 0 ? text(cells[idx]) : "");
    // VTOP shows "-" for not-yet-allotted venue/seat.
    const orBlank = (s: string) => (s.replace(/-/g, "").trim() ? s : "");

    const time = cell(timeIdx);
    const timings = time.split("-");
    schedules.push({
      examType: examTitle,
      courseCode: cell(codeIdx),
      courseName: cell(titleIdx),
      slot: cell(slotIdx).split("+")[0],
      examDate: cell(dateIdx).toUpperCase(),
      session:
        cell(sessionIdx) ||
        (timings.length === 2 ? `${timings[0].trim()} - ${timings[1].trim()}` : ""),
      time,
      venue: orBlank(cell(venueIdx)),
      seatNo: orBlank(cell(seatIdx)),
      seatLocation: orBlank(cell(locationIdx)),
    });
  }

  return schedules;
}

// "P" = pass in a non-credit course (Bhopal); recognised as a grade, kept out of GPA.
const GRADE_SET = new Set<string>([...GRADE_LETTERS, "P"]);

/**
 * Grades that count as a completed AND earned course. Shared by grade-history
 * earned-credit totals and pending-subject detection so the two can never
 * disagree on the same row (a blank/unknown grade earns nothing and stays
 * pending). F failed, N never graded.
 */
const PASSING_GRADES = new Set(["S", "A", "B", "C", "D", "E", "P"]);
/** "Nov 2025", "November-2025", "Nov'2025" — an exam-month token. A real month
 * name is required: a bare letters+digits pattern also matched course codes
 * (ENG1004), so every course became its own "semester". */
const MONTH_YEAR_RE =
  /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s.,'-]*\d{4}$/i;

/**
 * Pull one grade row's fields out of its cell texts by CONTENT, not fixed
 * column index, so the parser survives VTOP reordering/adding columns (the
 * usual cause of "grades didn't parse"). Returns null for rows that aren't a
 * course-grade row (header, summary, detail). A row needs at least a course
 * code and an exam-month token to count.
 */
function extractGradeRow(
  texts: string[]
): { record: GradeRecord; examMonth: string } | null {
  const codeIdx = texts.findIndex((t) => /^[A-Z]{2,}\d{3,4}[A-Z]?$/.test(t));
  if (codeIdx < 0) return null;
  const examMonth = texts.find((t) => MONTH_YEAR_RE.test(t)) ?? "";
  if (!examMonth) return null;

  // Grade: the first lone grade letter (S/A/B/.../N) after the code.
  let gradeIdx = -1;
  for (let i = codeIdx + 1; i < texts.length; i++) {
    if (GRADE_SET.has(texts[i].toUpperCase())) {
      gradeIdx = i;
      break;
    }
  }
  const grade = gradeIdx >= 0 ? texts[gradeIdx].toUpperCase() : "";
  const end = gradeIdx >= 0 ? gradeIdx : texts.length;

  // Credits: a plain number (≤ 30) after the code — the Sl.No sits before the
  // code, so it isn't mistaken for credits. Scan the whole tail (not just up to
  // the grade) because some layouts put Credits after the Grade column; skip the
  // grade cell itself and exam-month tokens.
  let credits = 0;
  for (let i = codeIdx + 1; i < texts.length; i++) {
    if (i === gradeIdx || MONTH_YEAR_RE.test(texts[i])) continue;
    if (/^\d+(\.\d+)?$/.test(texts[i]) && +texts[i] <= 30) credits = +texts[i];
  }
  // Title/type: the non-numeric, non-grade cells right after the code.
  const meta = texts
    .slice(codeIdx + 1, end)
    .filter((t) => t && !/^\d+(\.\d+)?$/.test(t) && !GRADE_SET.has(t.toUpperCase()));

  return {
    record: {
      courseCode: texts[codeIdx],
      courseName: meta[0] ?? "",
      courseType: meta[1] ?? "",
      credits,
      grade,
      gradePoints: (GRADE_POINTS as Record<string, number>)[grade] ?? 0,
    },
    examMonth,
  };
}

export function parseGradeHistory(html: string): GradeHistory {
  const $ = cheerio.load(html);
  const history: GradeHistory = {
    semesters: [],
    cgpa: 0,
    totalCredits: 0,
  };

  const summary = parseCgpaSummary($);
  if (summary) {
    history.cgpa = summary.cgpa;
    history.totalCredits = summary.creditsEarned;
  }

  // Walk the "Effective Grades" table for per-course rows, then group by exam
  // month. Prefer the tagged rows (tr.tableContent); if VTOP dropped/renamed
  // that class, fall back to scanning every row — extractGradeRow ignores
  // anything that isn't a real course-grade row. Detail rows (id="detailsView_")
  // are always skipped.
  let rows = $("table tr.tableContent").toArray();
  if (rows.length === 0) rows = $("table tr").toArray();

  const grouped = new Map<string, GradeRecord[]>();
  for (const tr of rows) {
    const $tr = $(tr);
    if ($tr.attr("id")?.startsWith("detailsView_")) continue;
    const texts = $tr
      .find("td")
      .map((_j, el) => $(el).text().replace(/\s+/g, " ").trim())
      .get();
    const parsed = extractGradeRow(texts);
    if (!parsed) continue;
    const { record, examMonth } = parsed;
    const bucket = grouped.get(examMonth) ?? [];
    bucket.push(record);
    grouped.set(examMonth, bucket);
  }

  const monthTime = (m: string) => Date.parse(`1 ${m.replace(/[-.,']/g, " ")}`) || 0;
  const byDate = [...grouped].sort(([a], [b]) => monthTime(a) - monthTime(b));
  for (const [examMonth, grades] of byDate) {
    // Earned shares pending's definition of "completed": only the passing
    // set banks credit, so a blank/unknown grade can never be both earned
    // here and pending there.
    const earnedCredits = grades.reduce(
      (s, g) => s + (PASSING_GRADES.has(g.grade) ? g.credits : 0),
      0
    );
    const graded = grades.filter((g) => g.grade && g.grade !== "P");
    const weightedPoints = graded.reduce(
      (s, g) => s + g.gradePoints * g.credits,
      0
    );
    const totalCredits = graded.reduce((s, g) => s + g.credits, 0);
    // A term containing only P (pass) / non-graded courses has no GPA-bearing
    // credit at all. Reporting 0 there reads as a failed semester, so it is null
    // ("no GPA computed") and the credits are still shown.
    const gpa = totalCredits > 0 ? weightedPoints / totalCredits : null;
    history.semesters.push({
      semester: examMonth,
      gpa: gpa === null ? null : Math.round(gpa * 100) / 100,
      credits: earnedCredits,
      grades,
    });
  }

  return history;
}

/**
 * Parse semester grades from examinations/examGradeView/doStudentGradeView.
 *
 * Android app: first table, headings with 'code' and 'grade'.
 * GPA from last cell text split by ':'.
 *
 * `published` distinguishes "VTOP has no results for this term yet" from a
 * real result. Reporting a GPA of 0 for an in-progress semester reads exactly
 * like academic failure, which is why the GPA is null rather than 0 in that
 * case — callers must check `published`.
 */
export function parseSemesterGrades(html: string): {
  grades: GradeRecord[];
  /** null when no results have been published for this semester. */
  gpa: number | null;
  published: boolean;
} {
  const $ = cheerio.load(html);
  const result: { grades: GradeRecord[]; gpa: number | null; published: boolean } = {
    grades: [],
    gpa: null,
    published: false,
  };

  if (html.toLowerCase().includes("no records")) return result;

  const table = $("table").first();
  if (!table.length) return result;

  // Expand the top header row's colspans into one label per data column.
  // "Credits" spans its sub-columns (Bhopal: L P J C); the last one is the total.
  // Rows are matched by cell count: stepping a flat <td> list broke when the
  // sub-header row and extra columns (Grading Type, Grand Total) shifted it.
  const cols: string[] = [];
  let creditsIdx = -1;
  table.find("tr").first().children("th, td").each((_i, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim().toLowerCase();
    const span = parseInt($(el).attr("colspan") ?? "1", 10) || 1;
    for (let k = 0; k < span; k++) cols.push(text);
    if (text.includes("credit")) creditsIdx = cols.length - 1;
  });
  const col = (pred: (h: string) => boolean) => cols.findIndex(pred);
  const codeIdx = col((h) => h.includes("code"));
  const titleIdx = col((h) => h.includes("title"));
  const typeIdx = col((h) => h.includes("course type"));
  const gradeIdx = col((h) => h.includes("grade") && !h.includes("grading"));
  if (codeIdx < 0 || gradeIdx < 0) return result;

  for (const tr of table.find("tr").toArray()) {
    const cells = $(tr).children("td").toArray().map((c) => $(c).text().replace(/\s+/g, " ").trim());
    if (cells.length !== cols.length || !cells[codeIdx]) continue;
    const grade = cells[gradeIdx].toUpperCase();
    result.grades.push({
      courseCode: cells[codeIdx],
      courseName: titleIdx >= 0 ? cells[titleIdx] : "",
      courseType: typeIdx >= 0 ? cells[typeIdx] : "",
      credits: creditsIdx >= 0 ? parseFloat(cells[creditsIdx]) || 0 : 0,
      grade,
      gradePoints: (GRADE_POINTS as Record<string, number>)[grade] ?? 0,
    });
  }

  // "GPA : 5.0" (Bhopal) / "SGPA : 8.58" (Chennai)
  const gpa = table.text().match(/GPA\s*:\s*([\d.]+)/i);
  if (gpa) {
    const parsed = parseFloat(gpa[1]);
    if (Number.isFinite(parsed)) result.gpa = parsed;
  }
  // Grades present = results actually published. An in-progress term has
  // neither rows nor a GPA, and must not be reported as a GPA of 0.
  result.published = result.grades.length > 0 || result.gpa !== null;

  return result;
}

/**
 * Parse student profile from studentsRecord/StudentProfileAllView.
 *
 * Android app: Iterates <td> cells, finds label cells with key text,
 * reads the next cell as value.
 */
/**
 * Programme and branch from the grade-history header ("Programme and Branch":
 * "B.Tech. - Electronics and Communication Engineering (…)"). Bhopal's profile
 * page has no degree branch, only the Class 12 stream.
 */
export function parseProgrammeBranch(html: string): { program: string; branch: string } | null {
  const $ = cheerio.load(html);
  for (const tr of $("tr").toArray()) {
    const heads = $(tr).children("td,th").toArray().map((c) => $(c).text().replace(/\s+/g, " ").trim().toLowerCase());
    const idx = heads.findIndex((h) => h.includes("programme") && h.includes("branch"));
    if (idx < 0) continue;
    const value = $($(tr).next("tr").children("td,th").toArray()[idx]).text().replace(/\s+/g, " ").trim();
    if (!value) return null;
    const [program, ...rest] = value.split(" - ");
    return { program: program.trim(), branch: rest.join(" - ").trim() };
  }
  return null;
}

export function parseProfile(html: string): StudentProfile {
  const $ = cheerio.load(html);

  const profile: StudentProfile = {
    name: "",
    registrationNumber: "",
    applicationNumber: "",
    program: "",
    branch: "",
    school: "",
    email: "",
    phone: "",
    bloodGroup: "",
  };

  // Registration number lives in a hidden input, not a table cell.
  const regnoInput = $('input[name="regno"]').attr("value");
  if (regnoInput) profile.registrationNumber = regnoInput.trim();

  const cells = $("td");
  for (let i = 0; i < cells.length - 1; i++) {
    const key = $(cells[i]).text().trim().toLowerCase().replace(/\s+/g, " ");
    const value = $(cells[i + 1]).text().trim();
    if (!value) continue;

    // First-match semantics: don't overwrite once a field has been set. VTOP
    // pages repeat similar labels in faculty/address sections, and the first
    // occurrence is the student's own personal info block.
    if (!profile.name && key === "student name") {
      profile.name = value;
    } else if (!profile.applicationNumber && key === "application number") {
      profile.applicationNumber = value;
    } else if (
      !profile.program &&
      (key === "programme" || key === "applied degree" || key === "degree")
    ) {
      profile.program = value;
    } else if (
      !profile.branch &&
      key === "branch" // not "branch / group studied": that's the Class 12 stream (e.g. PCM)
    ) {
      profile.branch = value;
    } else if (!profile.school && key === "school") {
      profile.school = value;
    } else if (!profile.email && key === "email") {
      profile.email = value;
    } else if (!profile.phone && key === "mobile number") {
      profile.phone = value;
    } else if (!profile.bloodGroup && key === "blood group") {
      profile.bloodGroup = value;
    }
  }

  return profile;
}

/**
 * Parse curriculum progress from the grade-history HTML.
 *
 * Pulls three things from tables on the page:
 *   - Curriculum Details: per high-level distribution type
 *     (Foundation Core, Discipline Core, Electives, ... + Total Credits row)
 *   - Basket Details: per fine-grained basket with its parent distribution type
 *   - CGPA summary header row: total credits registered, earned, CGPA,
 *     and grade-letter counts (S/A/B/.../N)
 *
 * Robust to surrounding markup changes by matching tables on their header
 * cell text rather than DOM position.
 */
function buildProgressRow(
  name: string,
  required: number,
  earned: number,
  distributionType?: string
): CurriculumProgressRow {
  const m = progressMetrics(required, earned);
  return {
    name,
    ...(distributionType !== undefined ? { distributionType } : {}),
    creditsRequired: required,
    creditsEarned: earned,
    creditsRemaining: m.creditsRemaining,
    percentComplete: m.percentComplete,
  };
}

export function parseCurriculumProgress(html: string): CurriculumProgress {
  const $ = cheerio.load(html);

  const progress: CurriculumProgress = {
    totals: {
      creditsRegistered: 0,
      creditsRequired: 0,
      creditsEarned: 0,
      creditsRemaining: 0,
      percentComplete: 0,
      cgpa: 0,
    },
    distributionTypes: [],
    baskets: [],
    gradeDistribution: { S: 0, A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, N: 0 },
  };

  $("table").each((_i, tableEl) => {
    const $table = $(tableEl);
    const headerText = $table.find("tr").first().text().toLowerCase();

    if (headerText.includes("curriculum details")) {
      $table.find("tr.tableContent, tr.fixedContent").each((_j, tr) => {
        const cells = $(tr).find("td");
        if (cells.length < 3) return;
        const name = $(cells[0]).text().trim();
        const required = parseFloat($(cells[1]).text().trim()) || 0;
        const earned = parseFloat($(cells[2]).text().trim()) || 0;
        if (name.toLowerCase() === "total credits") {
          progress.totals.creditsRequired = required;
          progress.totals.creditsEarned = earned;
          return;
        }
        progress.distributionTypes.push(buildProgressRow(name, required, earned));
      });
    }

    if (headerText.includes("basket details")) {
      $table.find("tr.tableContent").each((_j, tr) => {
        const cells = $(tr).find("td");
        if (cells.length < 4) return;
        const name = $(cells[0]).text().trim();
        const distributionType = $(cells[1]).text().trim();
        const required = parseFloat($(cells[2]).text().trim()) || 0;
        const earned = parseFloat($(cells[3]).text().trim()) || 0;
        progress.baskets.push(
          buildProgressRow(name, required, earned, distributionType)
        );
      });
    }
  });

  const summary = parseCgpaSummary($);
  if (summary) {
    progress.totals.creditsRegistered = summary.creditsRegistered;
    progress.totals.cgpa = summary.cgpa;
    progress.gradeDistribution = summary.gradeDistribution;
  }

  const totalsMetrics = progressMetrics(
    progress.totals.creditsRequired,
    progress.totals.creditsEarned
  );
  progress.totals.creditsRemaining = totalsMetrics.creditsRemaining;
  progress.totals.percentComplete = totalsMetrics.percentComplete;

  return progress;
}


/**
 * Generic accordion-section reader for the info pages (profile, proctor).
 * Every section is a heading followed by label/value table rows: find each
 * section heading, then read key/value cell pairs until the next heading.
 */
function splitInfoSections(
  html: string,
  headingSelector: string,
): { title: string; fields: Record<string, string> }[] {
  const $ = cheerio.load(html);
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const sections: { title: string; fields: Record<string, string> }[] = [];

  $(headingSelector).each((_, h) => {
    const title = clean($(h).text()).toUpperCase();
    if (!title) return;
    const fields: Record<string, string> = {};
    // Anchor on the heading element itself: the matched button sits INSIDE
    // the heading (h2 > button), while the section body follows the heading.
    // Walking the button's own siblings finds nothing.
    const anchor = $(h).closest("h1,h2,h3,h4");
    const start = anchor.length > 0 ? anchor : $(h).parent();
    const stopTag = start.prop("tagName");
    let guard = 0;
    for (
      let cur = start.next();
      cur.length > 0 && guard < 400;
      cur = cur.next(), guard++
    ) {
      if (cur.prop("tagName") === stopTag && clean(cur.text())) break;
      cur.find("tr").each((_, tr) => {
        const cells = $(tr)
          .children("td,th")
          .toArray()
          .map((c) => clean($(c as never).text()));
        for (let i = 0; i + 1 < cells.length; i += 2) {
          if (cells[i] && !(cells[i] in fields)) fields[cells[i]] = cells[i + 1] ?? "";
        }
      });
    }
    if (Object.keys(fields).length > 0) sections.push({ title, fields });
  });

  return sections;
}

/**
 * Full student profile: the accordion sections of
 * studentsRecord/StudentProfileAllView (personal, educational, family,
 * proctor, hostel), exactly as VTOP groups them. Values are verbatim strings.
 */
export function parseStudentProfileFull(html: string): ProfileSection[] {
  return splitInfoSections(html, "h2 button.accordion-button, h2 .accordion-button");
}

/**
 * Proctor details, flat. The proctor/viewProctorDetails page carries the same
 * table as the profile's proctor section.
 */
export function parseProctorDetails(html: string): ProctorDetails {
  const $ = cheerio.load(html);
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const get = (...labels: string[]): string => {
    for (const tr of $("tr").toArray()) {
      const cells = $(tr)
        .children("td,th")
        .toArray()
        .map((c) => clean($(c as never).text()));
      for (let i = 0; i + 1 < cells.length; i += 2) {
        if (labels.some((l) => cells[i].toLowerCase() === l.toLowerCase())) {
          return cells[i + 1] ?? "";
        }
      }
    }
    return "";
  };
  return {
    facultyId: get("faculty id"),
    name: get("faculty name"),
    designation: get("faculty designation"),
    school: get("school"),
    department: get("faculty department"),
    cabin: get("cabin"),
    email: get("faculty email"),
    intercom: get("faculty intercom"),
    mobile: get("faculty mobile number"),
  };
}

/**
 * Admission document checklist from admissions/AcknowledgmentView.
 * Rows are (Sl.No, document, status); the header row is skipped by content.
 */
export function parseAcknowledgments(html: string): Acknowledgment[] {
  const $ = cheerio.load(html);
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const out: Acknowledgment[] = [];
  $("tr").each((_, tr) => {
    const cells = $(tr)
      .children("td")
      .toArray()
      .map((c) => clean($(c as never).text()));
    if (cells.length < 3) return;
    const doc = cells[1] ?? "";
    const status = cells[cells.length - 1] ?? "";
    if (!doc || /^(sl\.?\s*no|s\.no)/i.test(doc)) return;
    if (!/submitted|not applicable|pending|verified/i.test(status)) return;
    out.push({ document: doc, status });
  });
  return out;
}

/**
 * Programme curriculum baskets from academics/common/Curriculum.
 *
 * Each category tab holds a course table (code, title, type, version, L/T/P/J,
 * credits). Completion is VTOP's own marking: rows carrying the `bg-success`
 * class are complete. That flag is reported verbatim as
 * `vtopMarkedCompleted` — the grade-history cross-check lives in
 * computePendingSubjects, not here.
 */
export function parseCurriculumBaskets(html: string): CurriculumBasket[] {
  const $ = cheerio.load(html);
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const num = (s: string): number => parseFloat(s.replace(/[^0-9.]/g, "")) || 0;
  const baskets: CurriculumBasket[] = [];

  $("table").each((_, tableEl) => {
    const $table = $(tableEl);
    const headerCells = $table
      .find("tr")
      .first()
      .children("td,th")
      .toArray()
      .map((c) => clean($(c as never).text()).toLowerCase());
    const isCourseTable =
      headerCells.some((h) => h.includes("course code")) &&
      headerCells.some((h) => h.includes("credit"));
    if (!isCourseTable) return;

    // Category is the nearest preceding tab/heading label.
    let category = "Uncategorised";
    const tab = $table.closest("[role='tabpanel'], .tab-pane");
    const tabId = tab.attr("id") ?? tab.attr("aria-labelledby") ?? "";
    if (tabId) {
      const label = clean($(`a[href='#${tabId}'], button[data-bs-target='#${tabId}']`).first().text());
      if (label) category = label;
    }
    if (category === "Uncategorised") {
      const prev = $table.prevAll("h1,h2,h3,h4,.nav-link.active").first().text();
      if (clean(prev)) category = clean(prev);
    }

    const courses: CurriculumCourse[] = [];
    const seen = new Set<string>();
    $table.find("tbody tr, tr").each((_, tr) => {
      const $tr = $(tr);
      const tds = $tr.children("td").toArray();
      if (tds.length < 8) return;
      const texts = tds.map((c) => clean($(c as never).text()));
      // Course code located by content, not column index: a prepended
      // checkbox/Sl.No column would otherwise shift every field. Remaining
      // fields anchor relative to the code cell for the same reason.
      const codeIdx = texts.findIndex((t) => /^[A-Z]{2,}\d+[A-Z]*$/.test(t.trim()));
      if (codeIdx < 0) return;
      const code = (texts[codeIdx].match(/[A-Z]{2,}\d+[A-Z]*/)?.[0] ?? "").trim();
      if (!/^[A-Z]{2,}\d/.test(code) || seen.has(code)) return;
      seen.add(code);
      const at = (i: number) => texts[codeIdx + i] ?? "";
      courses.push({
        code,
        title: at(1),
        type: at(2),
        version: at(3),
        l: num(at(4)),
        t: num(at(5)),
        p: num(at(6)),
        j: num(at(7)),
        credits: num(texts[texts.length - 1] ?? ""),
        vtopMarkedCompleted: ($tr.attr("class") ?? "").split(/\s+/).includes("bg-success"),
      });
    });

    if (courses.length > 0) baskets.push({ category, courses });
  });

  return baskets;
}

/**
 * Pending subjects = curriculum baskets minus grade-history passes.
 *
 * Rules, all verified against live VTOP behaviour:
 * - Join ONLY on course code. Timetable labels are instructional semesters,
 *   grade-history labels are result-publication months — never comparable.
 * - "Completed" = the LATEST grade on record is a passing grade. Latest =
 *   the last exam-month bucket holding that course (history is date-sorted).
 * - VTOP's own bg-success marking is reported alongside, and any disagreement
 *   lands in `discrepancies` — never silently resolved in either direction.
 * - Elective baskets (only N of M credits required) still list every
 *   uncompleted basket course; the category totals say how many credits short.
 */
export function computePendingSubjects(
  baskets: CurriculumBasket[],
  history: GradeHistory,
): {
  pending: (PendingSubject & { category: string })[];
  completedCount: number;
  discrepancies: CompletionDiscrepancy[];
} {
  const latest: Record<string, { grade: string; title: string }> = {};
  for (const sem of history.semesters) {
    for (const g of sem.grades) {
      latest[g.courseCode] = { grade: g.grade, title: g.courseName };
    }
  }
  const gradeCompleted = (code: string): { done: boolean; grade: string | null } => {
    const rec = latest[code];
    if (!rec) return { done: false, grade: null };
    return { done: PASSING_GRADES.has(rec.grade), grade: rec.grade };
  };

  const pending: (PendingSubject & { category: string })[] = [];
  const discrepancies: CompletionDiscrepancy[] = [];
  let completedCount = 0;

  for (const basket of baskets) {
    for (const course of basket.courses) {
      const { done, grade } = gradeCompleted(course.code);
      if (done) {
        completedCount++;
      } else {
        pending.push({
          ...course,
          category: basket.category,
          latestGrade: grade,
          completedPerGrades: false,
        });
      }
      if (done !== course.vtopMarkedCompleted) {
        discrepancies.push({
          courseCode: course.code,
          courseTitle: course.title,
          vtopMarkedCompleted: course.vtopMarkedCompleted,
          gradeBasedCompleted: done,
          latestGrade: grade,
        });
      }
    }
  }

  return { pending, completedCount, discrepancies };
}

/**
 * Fee receipt list from finance/getStudentReceipts.
 * Columns: receipt number, date, amount, campus.
 */
export function parseFeeReceipts(html: string): FeeReceipt[] {
  const $ = cheerio.load(html);
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const out: FeeReceipt[] = [];

  $("tr").each((_, tr) => {
    const cells = $(tr)
      .children("td")
      .toArray()
      .map((c) => clean($(c as never).text()));
    if (cells.length < 4) return;
    // Receipt numbers are bare digits; the header row ("RECEIPT NUMBER") and
    // any non-data row fail this test.
    if (!/^\d+$/.test(cells[0] ?? "")) return;
    const amount = parseFloat((cells[2] ?? "").replace(/[^0-9.]/g, "")) || 0;
    out.push({
      receiptNumber: cells[0] ?? "",
      date: cells[1] ?? "",
      amount,
      campus: cells[3] ?? "",
    });
  });

  return out;
}

/**
 * One receipt's detail panel (finance/dupReceiptNewP2P response, as rendered
 * into the page). Generic label/value harvest: every table row's first cell
 * is the label, the rest joined is the value. Unknown layouts still yield
 * their visible text rather than an empty object.
 */
export function parseFeeReceiptDetail(
  receiptNumber: string,
  html: string,
): { receiptNumber: string; fields: Record<string, string> } {
  const $ = cheerio.load(html);
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const fields: Record<string, string> = {};
  $("tr").each((_, tr) => {
    const cells = $(tr)
      .children("td,th")
      .toArray()
      .map((c) => clean($(c as never).text()));
    if (cells.length < 2 || !cells[0]) return;
    const label = cells[0];
    const value = cells.slice(1).join(" / ");
    if (!(label in fields)) fields[label] = value;
  });
  const text = clean($.text());
  return { receiptNumber, fields: Object.keys(fields).length > 0 ? fields : { text: text.slice(0, 2000) } };
}

/**
 * Faculty directory search rows (hrms/EmployeeSearchForStudent response).
 *
 * The results table's header row reads "Name of the Faculty / Designation /
 * School / Centre / Action"; each data row carries the Action button whose
 * id AND getEmployeeIdNo("...") onclick hold the row's employee id (numeric
 * like "91001" or alphanumeric like "RST99"). The commented-out Employee ID
 * header cell is ignored — the button is the source of truth.
 *
 * A header-only table (or no results table at all) is a genuine zero-match
 * search, returned as []. An error-modal body ("not available", "unable to
 * process") is an UPSTREAM failure, never an empty directory.
 */
export function parseFacultySearch(html: string): FacultyMatch[] {
  const $ = cheerio.load(html);
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const bodyText = clean($.text());
  if (/this menu is not available|unable to process your request/i.test(bodyText)) {
    throw new VtopError(
      "UPSTREAM",
      "VTOP did not return a faculty search result.",
      bodyText.slice(0, 200),
    );
  }
  const out: FacultyMatch[] = [];
  $("table").each((_, table) => {
    const header = $(table)
      .find("tr")
      .first()
      .children("td,th")
      .toArray()
      .map((c) => clean($(c as never).text()).toLowerCase());
    if (!header.some((h) => h.includes("name of the faculty"))) return;
    $(table)
      .find("tr")
      .slice(1)
      .each((_, tr) => {
        const cells = $(tr)
          .children("td")
          .toArray()
          .map((c) => clean($(c as never).text()));
        if (cells.length < 3 || !cells[0]) return;
        if (/name of the faculty/i.test(cells[0])) return;
        const action = $(tr).find("button[onclick*='getEmployeeIdNo'],button[id]").first();
        const onclick = action.attr("onclick") ?? "";
        const fromOnclick = onclick.match(/getEmployeeIdNo\(["']([^"']+)["']\)/);
        const employeeId = fromOnclick?.[1] ?? action.attr("id") ?? "";
        out.push({
          name: cells[0] ?? "",
          designation: cells[1] ?? "",
          school: cells[2] ?? "",
          employeeId,
        });
      });
  });
  return out;
}

/**
 * One faculty member's detail card (hrms/EmployeeSearch1ForStudent response).
 *
 * A bordered table of label/value rows: "Name of the Faculty", "Designation",
 * "Name of Department", "School / Centre Name", "E-Mail Id", "Cabin Number".
 * A literal "null" cabin means VTOP published none and normalises to null.
 * The photo cell (rowspan, base64 img) is skipped — identity photos are not
 * directory data. Mobile/intercom rows are commented out server-side for most
 * records, so their absence is normal, not a parse failure.
 */
export function parseFacultyDetail(employeeId: string, html: string): FacultyDetail {
  const $ = cheerio.load(html);
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const bodyText = clean($.text());
  if (/this menu is not available|unable to process your request/i.test(bodyText)) {
    throw new VtopError(
      "UPSTREAM",
      `VTOP did not return a detail card for employee id "${employeeId}".`,
      bodyText.slice(0, 200),
    );
  }
  const get = (...labels: string[]): string => {
    for (const tr of $("table.table-bordered tr").toArray()) {
      const cells = $(tr)
        .children("td,th")
        .toArray()
        .map((c) => clean($(c as never).text()));
      if (cells.length < 2 || !cells[0]) continue;
      if (labels.some((l) => cells[0].toLowerCase() === l.toLowerCase())) {
        return cells[1] ?? "";
      }
    }
    return "";
  };
  const cabinRaw = get("cabin number");
  const detail: FacultyDetail = {
    employeeId,
    name: get("name of the faculty"),
    designation: get("designation"),
    department: get("name of department"),
    school: get("school / centre name"),
    email: get("e-mail id"),
    cabin: !cabinRaw || /^null$/i.test(cabinRaw) ? null : cabinRaw,
  };
  // A card with no name is a layout change, not an anonymous faculty member.
  if (!detail.name) {
    throw new VtopError(
      "UPSTREAM",
      `VTOP returned a detail card with no recognisable fields for employee id "${employeeId}".`,
      "The layout may have changed. Not treated as an empty record.",
    );
  }
  return detail;
}
