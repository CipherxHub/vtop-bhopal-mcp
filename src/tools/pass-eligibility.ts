import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VtopClient } from "../services/vtop-client.js";
import { parseMarks, parseAttendance, parseTimetableGrid, parseExamSchedule } from "../services/vtop-parser.js";
import { ENDPOINTS } from "../services/constants.js";
import {
  assessCourse,
  attendanceRunway,
  sessionsBefore,
  instructionalDaysBetween,
  type CatAssessment,
} from "../services/exam-eligibility.js";
import { SemesterInputSchema } from "../schemas/index.js";
import { mkJsonTool } from "./_helpers.js";
import type { Weekday } from "../services/attendance-calc.js";

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Today in IST (VIT is UTC+5:30), as ISO YYYY-MM-DD. */
function istToday(): string {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/** "30-OCT-2026" -> "2026-10-30". Empty/unparseable -> null. */
// Exam date/time parsing lives in leave.ts and is shared with apply_leave, so
// both tools read VTOP's "30-OCT-2026" / "01:15 PM - 04:15 PM" one way.
import { normaliseExamDate } from "../services/leave.js";

export function registerPassEligibilityTool(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "check_pass_eligibility",
    "Answer 'will I pass this course?' for every subject, using VIT Bhopal's actual pass rules rather than guessing. " +
      "ALWAYS quote BOTH scales when asked what to score. Each CAT is a 50-mark paper needing 20, which is worth 6 of the 15 that CAT carries on the 100-point course scale. The TEE (FAT) is a 100-mark paper worth 30 of 100, and must reach 40 - worth 12 of those 30. So the canonical answer is '20/50 in each CAT, worth 6 of 15 each, and 40/100 in the TEE, worth 12 of 30'. " +
      "Rules applied: passing is 80 raw marks out of 200 (CAT-I 20 + CAT-II 20 + TEE 40), equivalently CAT-I + CAT-II + TEE >= 80 raw. The TEE's own end goal is 40 of 100, and whatever the two CATs fall SHORT of 40 BETWEEN THEM is added to it - this is net, so a CAT above 20 offsets one below it (10 and 10 needs the TEE at 60, but 30 and 10 needs only 40). There is no re-test. Attendance must be >= 75.0% exactly to sit any exam. " +
      "READ `teeRequiredRaw` AS THE ANSWER to 'what do I need in the TEE'. Do NOT present `totalIfTeeClearedAtMinimum` as a requirement - it is an OUTCOME: the course total you would finish with by scoring exactly the TEE minimum, i.e. `bankedSoFar` + `teeRequiredMarks`. The attendance marks are excluded from it because they are a projection awarded only after the last instructional day. " +
      "Working-day and class counts come from the academic calendar and timetable, so holidays and day-order Saturdays are accounted for. If the calendar cannot be read, `upcomingClasses` is null and `calendarAvailable` is false with a `calendarNote` explaining why - that means UNKNOWN, not zero. " +
      " semesterId is optional; omit for current semester. Requires login.",
    SemesterInputSchema.shape,
    async ({ semesterId }) => {
      const id = semesterId ?? (await client.getCurrentSemesterId());
      const today = istToday();

      // Marks and attendance are independent; fetch together.
      const [marksHtml, attHtml, timetableHtml] = await Promise.all([
        client.getMarksHtml(id),
        client.getAttendanceHtml(id).catch(() => null),
        client.getTimetableHtml(id),
      ]);

      const marks = parseMarks(marksHtml);
      const attendance = attHtml ? parseAttendance(attHtml) : [];
      const sessions = parseTimetableGrid(timetableHtml);

      // Which FAT falls on which day, and the working days left before each.
      let examHtml: string | null = null;
      try {
        examHtml = await client.getExamScheduleHtml(id);
      } catch {
        /* deadlines are best-effort; the pass rules still evaluate */
      }
      const exams = examHtml ? parseExamSchedule(examHtml) : [];

      // Calendar over the whole remaining term, used to count classes per course.
      let calendar: Awaited<ReturnType<VtopClient["getCalendar"]>> = [];
      // If the calendar cannot be read, upcoming-class counts are unknowable.
      // Report that rather than showing a bare 0, which would read as "no
      // classes left" — a materially different and much more reassuring claim.
      let calendarError: string | null = null;
      const fatDates = exams
        .filter((e) => /fat|term\s*end/i.test(e.examType))
        .map((e) => normaliseExamDate(e.examDate))
        .filter((d): d is string => !!d && d >= today);

      // Each course has its OWN FAT date, and they differ. Using one global
      // deadline (the last FAT of the whole semester) for every course is
      // wrong: the Term End Examinations run across many days, so every course
      // was being assessed against the final exam day rather than its own.
      const fatDateByCourse = new Map<string, string>();
      for (const e of exams) {
        if (!/fat|term\s*end/i.test(e.examType)) continue;
        const d = normaliseExamDate(e.examDate);
        if (!d || d < today) continue;
        const code = (e.courseCode || "").toUpperCase();
        if (!code) continue;
        const prev = fatDateByCourse.get(code);
        // Keep the earliest upcoming sitting for this course.
        if (!prev || d < prev) fatDateByCourse.set(code, d);
      }
      // The calendar still has to span the whole exam window to be useful.
      const latest = fatDates.slice().sort().at(-1);
      // Fallback for a course with no dated row: its own earliest sitting is
      // unknown, so use the earliest upcoming FAT rather than the latest.
      const earliest = fatDates.slice().sort().at(0) ?? null;
      let lastInstructionalDay: string | null = null;
      if (latest) {
        try {
          // Fetch a few weeks of lookback as well. `getCalendar` returns only
          // the window asked for, and the last instructional day usually falls
          // BEFORE today - by the time exams start, teaching is already over,
          // so a window starting today would contain no instructional day at
          // all and we could not say when teaching ended.
          const lookback = new Date(`${today}T00:00:00Z`);
          lookback.setUTCDate(lookback.getUTCDate() - 28);
          const calendarFrom = lookback.toISOString().slice(0, 10);
          calendar = await client.getCalendar(id, calendarFrom, latest);
          const instructional = calendar.filter((d) => d.instructional).length;
          lastInstructionalDay =
            calendar
              .filter((d) => d.instructional)
              .map((d) => d.date)
              .sort()
              .at(-1) ?? null;
          console.error(
            `VtopMCP: calendar ${calendarFrom}..${latest} -> ${calendar.length} days, ` +
              `${instructional} instructional, last instructional ${lastInstructionalDay}`,
          );
          // Only an EMPTY calendar means we cannot count classes. Zero
          // instructional days in the window is a real, meaningful state -
          // it means teaching has finished and only exams remain - and must
          // not be reported as "unknown".
          if (calendar.length === 0) {
            calendarError =
              `the academic calendar for ${id} returned no days at all, ` +
              "so remaining classes cannot be counted";
          }
        } catch (err) {
          calendarError = err instanceof Error ? err.message : String(err);
          console.error(`VtopMCP: calendar fetch failed — ${calendarError}`);
        }
      } else {
        calendarError = "no FAT date published yet, so the window is unknown";
      }

      const classesRemain = calendar.some(
        (d) => d.instructional && d.date >= today,
      );

      const attByCourse = new Map(attendance.map((a) => [a.courseCode.toUpperCase(), a]));

      const subjects = marks.map((rec) => {
        const code = rec.courseCode.toUpperCase();
        const att = attByCourse.get(code);

        // Identify the two CATs and the FAT from the published components.
        const cat1 = rec.marks.find((m) => /assessment\s*test\s*-\s*i\b|^cat\s*-?\s*1\b|mid\s*term/i.test(m.component));
        const cat2 = rec.marks.find((m) => /assessment\s*test\s*-\s*ii\b|^cat\s*-?\s*2\b/i.test(m.component));
        const midTerm = rec.marks.find((m) => /mid\s*term/i.test(m.component));
        const fatComp = rec.marks.find((m) => /term\s*end|\bfat\b/i.test(m.component));

        // A single "Mid Term" row (older layout) stands in for both CATs.
        const cat1Raw = cat1 ? cat1.scored : midTerm ? midTerm.scored : null;
        const cat2Raw = cat2 ? cat2.scored : midTerm ? midTerm.scored : null;

        const hasCats = !!cat1 || !!cat2 || !!midTerm;
        const cats: CatAssessment[] = hasCats
          ? [
              { label: "CAT-I", raw: cat1Raw },
              { label: "CAT-II", raw: cat2Raw },
            ]
          : [];

        const fatRaw = fatComp ? fatComp.scored : null;
        // Sum of EVERY component VTOP has published a mark for, on the 100-point
        // scale. This already includes the CATs once they are scored, so it must
        // NOT be added to the CAT contribution again.
        const scoredSoFar = round2(rec.marks.reduce((s, m) => s + m.weightage, 0));

        const verdict = hasCats
          ? assessCourse(cats, fatRaw, {
              scoredSoFar,
              attendancePercent: att ? att.percentage : null,
            })
          : null;

        // Attendance runway against THIS course's own FAT date.
        const ownFatDate = fatDateByCourse.get(code) ?? earliest;
        const fatDate = ownFatDate ?? null;
        const myDays = Array.from(
          new Set(
            sessions.filter((s) => s.courseCode.toUpperCase() === code).map((s) => s.day),
          ),
        ) as Weekday[];
        const upcomingKnown = fatDate !== null && calendarError === null;
        const upcoming = upcomingKnown
          ? sessionsBefore(myDays, calendar, today, fatDate)
          : null;
        const runway = att
          ? {
              ...attendanceRunway(
                { attended: att.attended, total: att.total },
                // When the count is unknowable, report the status quo (0
                // remaining classes) for the buffer arithmetic but flag it, so
                // the runway is not presented as if it were measured.
                upcoming ?? 0,
              ),
              upcomingClasses: upcoming,
              upcomingClassesKnown: upcomingKnown,
              instructionalDays: fatDate
                ? instructionalDaysBetween(calendar, today, fatDate)
                : 0,
              instructionalDaysKnown: fatDate !== null && calendarError === null,
              meetsPerWeek: myDays.length,
              fatDate,
            }
          : null;

        return {
          courseCode: rec.courseCode,
          courseName: rec.courseName,
          hasCats,
          cats: verdict?.cats ?? null,
          internalMarksSoFar: scoredSoFar,
          scoredSoFar,
          catMarksIncludedInScoredTotal: true,
          teeRequiredRaw: verdict?.teeRequiredRaw ?? null,
          teeRawMax: verdict?.teeRawMax ?? null,
          teeRequiredMarks: verdict?.teeRequiredMarks ?? null,
          teeRequirement: verdict?.teeRequirement ?? null,
          catRawSum: verdict?.catRawSum ?? null,
          catSurplus: verdict?.catSurplus ?? null,
          fatScored: fatRaw,
          teeMarks: verdict?.teeMarks ?? null,
          catMarks: verdict?.catMarks ?? null,
          bankedSoFar: scoredSoFar,
          // Named as an OUTCOME, not a requirement: this is the total you would
          // finish with by scoring exactly the TEE minimum, not a number to aim
          // for in the TEE itself.
          totalIfTeeClearedAtMinimum: verdict?.totalIfTeeClearedAtMinimum ?? null,
          status:
            verdict?.canPass === true
              ? "PASSING"
              : verdict?.canPass === false
                ? "AT RISK / FAILED"
                : "PENDING",
          blockers: verdict?.blockers ?? [],
          advisories: verdict?.advisories ?? [],
          rawTotalSoFar: verdict?.rawTotalSoFar ?? null,
          rawTotalRequired: verdict?.rawTotalRequired ?? null,
          attendance: runway,
        };
      });

      return {
        semesterId: id,
        today,
        fatWindow: { from: today, to: latest ?? null },
        perCourseFatDates: Object.fromEntries(fatDateByCourse),
        calendarAvailable: calendarError === null,
        calendarNote: calendarError,
        lastInstructionalDay,
        teachingOver:
          calendarError === null && !!lastInstructionalDay && !classesRemain
            ? `Teaching finished on ${lastInstructionalDay}. Every remaining day ` +
              "through the FAT is an examination day, so there are no classes " +
              "left to attend and the attendance percentage cannot fall further. " +
              "The 5 attendance marks are awarded once that last day passes."
            : null,
        rules: {
          weighting: {
            cat1: "50-mark paper worth 15 of 100; needs 20, which is worth 6 of 15",
            cat2: "50-mark paper worth 15 of 100; needs 20, which is worth 6 of 15",
            cam: "40 of 100 - continuous assessment, INCLUDING the 5 attendance marks",
            tee: "100-mark paper worth 30 of 100; needs 40, which is worth 12 of 30",
          },
          passingTotal:
            "80 raw marks out of 200 (CAT-I 20 + CAT-II 20 + TEE 40). " +
            "Equivalently: CAT-I + CAT-II + TEE >= 80 raw.",
          shortfallTransfer:
            "The TEE's end goal is always 40/100 (worth 12 of its 30). Whatever the " +
            "two CATs fall SHORT of 40 BETWEEN THEM is added to it. This is a NET " +
            "figure: a CAT scored above 20 offsets one scored below it. So 10 and " +
            "10 (sum 20) needs the TEE at 60; but 30 and 10 (sum 40) needs only 40. " +
            "The raw total lands on exactly 80 whenever the CATs total 40 or less.",
          readingTheTotals:
            "`teeRequiredRaw` is what you must score IN THE TEE (out of 100); " +
            "`teeRequiredMarks` is what that is worth on the 100-point course " +
            "scale (out of 30). `totalIfTeeClearedAtMinimum` is NOT a requirement - " +
            "it is the course total you would FINISH with by scoring exactly that, " +
            "i.e. bankedSoFar + teeRequiredMarks. Do not tell the student they " +
            "need to score that in the TEE.",
          attendanceGate:
            ">= 75.0% exactly to sit CAT-1, CAT-2 and the TEE. Attendance is also " +
            "worth 5 marks inside CAM, all-or-nothing at 75%+.",
          reTest:
            "THERE IS NO RE-TEST for CAT-1, CAT-2 or the TEE, so any shortfall is " +
            "permanent and can only be made up in the TEE.",
        },
        note:
          "IMPORTANT - read `blockers` and `advisories` differently. A CAT scored " +
          "below 20 is NOT a failure on its own: it appears in `advisories` with the " +
          "marks of shortfall that moved onto the TEE, and you still pass if the " +
          "TEE makes it up. `blockers` are only rules that are already broken - a " +
          "TEE below its required mark, attendance under 75%, or a CAT that was " +
          "never attempted (no mark row at all, and no re-test to recover it). " +
          "canPass is null while the TEE is still ahead: reachable but not decided. " +
          "Courses with hasCats false are practical-only or project courses, where " +
          "the CAT rule does not apply and only CAM and the TEE count.",
        subjects,
      };
    },
    {
      emptyMessage:
        "No marks records for this semester, so no pass-eligibility to evaluate. " +
        "Internal assessments may not be published yet.",
    }
  );
}