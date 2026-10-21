import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VtopClient } from "../services/vtop-client.js";
import { VtopError } from "../services/errors.js";
import {
  analyseDelta,
  analyseTarget,
  cgpaStateFrom,
  failedCourseImpacts,
  maxCgpa,
  nextDeadline,
  selectCoursesForBudget,
  GRADE_SCALE,
  type RemainingCourse,
} from "../services/cgpa-calc.js";
import { parseCurriculumBaskets, parseCurriculumProgress, parseExamSchedule, parseGradeHistory } from "../services/vtop-parser.js";
import { termBounds } from "../services/attendance-calc.js";
import { EmptySchema } from "../schemas/index.js";
import { mkJsonTool } from "./_helpers.js";

/** Today in IST, matching the rest of the tools. */
function istTodayISO(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * The courses still to complete, and the authoritative credit budget.
 *
 * Two different things, from two different sources:
 *
 * - The **credit budget** is VTOP's own: the curriculum progress page says how
 *   many credits the degree still needs (and per basket). That is the number
 *   the CGPA maths must use.
 * - The **course list** is the programme catalogue minus the courses already
 *   passed. It is an upper bound, not a to-do list: elective baskets list every
 *   option the programme offers, and the student only ever takes N of M. So the
 *   list is trimmed to the credit budget, largest course first.
 *
 * Using the raw catalogue-minus-passed total would overstate the remaining
 * work badly (a 100-course catalogue against a 74-credit remainder).
 */
async function remainingCourses(
  client: VtopClient,
): Promise<{ courses: RemainingCourse[]; source: string; creditsRequired: number; creditsRemaining: number }> {
  const [basketsHtml, historyHtml] = await Promise.all([
    client.getCurriculumBasketsHtml(),
    client.getGradeHistoryHtml(),
  ]);
  const baskets = parseCurriculumBaskets(basketsHtml);
  if (baskets.length === 0) {
    throw new VtopError(
      "UPSTREAM",
      "VTOP returned a curriculum page with no recognisable course tables.",
      "The layout may have changed; the remaining-courses list cannot be built.",
    );
  }
  const history = parseGradeHistory(historyHtml);
  const progress = parseCurriculumProgress(historyHtml);

  const passed = new Set(
    history.semesters
      .flatMap((s) => s.grades)
      .filter((g) => g.grade && g.grade !== "F" && g.grade !== "N")
      .map((g) => g.courseCode.toUpperCase()),
  );

  // VTOP's own remaining-credit figure is the authority. Fall back to the
  // basket sums when the totals page is missing.
  let creditsRemaining = progress.totals.creditsRemaining;
  if (!creditsRemaining) {
    creditsRemaining = progress.baskets.reduce(
      (s: number, b: { creditsRemaining: number }) => s + b.creditsRemaining,
      0,
    );
  }

  // Candidates: catalogue courses not yet passed, largest first, with the
  // non-graded baskets excluded (they carry no grade points).
  const candidates: RemainingCourse[] = [];
  for (const basket of baskets) {
    if (/non\s*-?\s*graded/i.test(basket.category)) continue;
    for (const course of basket.courses) {
      if (passed.has(course.code.toUpperCase())) continue;
      candidates.push({
        courseCode: course.code,
        courseName: course.title,
        credits: course.credits,
        category: basket.category,
      });
    }
  }

  // Trim to the credit budget: the list is a way to spend the remaining
  // credits, not the outstanding courses themselves.
  const courses = selectCoursesForBudget(candidates, creditsRemaining);

  return {
    courses,
    source: "curriculum catalogue trimmed to VTOP's remaining-credit budget",
    creditsRequired: progress.totals.creditsRequired,
    creditsRemaining,
  };
}

export function registerCgpaTools(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "get_cgpa_target",
    "What the courses you have LEFT must score to reach a target CGPA. Pass a target " +
      "(e.g. 8.5) and this reports: your CGPA now, the target, the maximum CGPA reachable " +
      "if everything scores S, the CGPA if everything fails, the average grade points you " +
      "need, and a concrete mix (e.g. '6 A and 2 B') that lands you on the target. If the " +
      "target is out of reach, it says so instead of pretending. Uses VIT's scale " +
      "(S=10, A=9, B=8, C=7, D=6, E=5, F=0; P courses carry no points). Read-only. Requires login.",
    {
      target: z.number().min(0).max(10).describe("Target CGPA, e.g. 8.5."),
    },
    async ({ target }) => {
      const history = parseGradeHistory(await client.getGradeHistoryHtml());
      const state = cgpaStateFrom(
        history.semesters.flatMap((s) => s.grades),
        history.cgpa,
        history.totalCredits,
      );
      const { courses, source, creditsRequired, creditsRemaining } = await remainingCourses(client);
      const analysis = analyseTarget(state, courses, target);
      return {
        ...analysis,
        creditsRequired,
        creditsRemaining,
        remainingCourseCount: courses.length,
        remainingCourses: courses,
        courseSource: source,
        gradeScale: GRADE_SCALE.map((g) => `${g.grade}=${g.points}`),
        note:
          "This is a requirement, not a prediction: it says what the remaining courses would " +
          "have to score. P (non-credit) courses carry no grade points, and a course you failed " +
          "counts in the denominator with zero points (VIT makes you re-register it, which " +
          "adds its credits to the denominator again).",
      };
    },
  );

  mkJsonTool(
    server,
    "get_cgpa_impact",
    "What a specific set of grades does to your CGPA. Pass courseCode -> grade for the " +
      "courses you have left (e.g. {\"CSD3002\": \"A\", \"CSD3010\": \"B\"}) and this reports " +
      "your CGPA now, the CGPA if those grades land, the difference, and the range if they " +
      "all scored S or all failed. Read-only. Requires login.",
    {
      grades: z
        .record(z.enum(["S", "A", "B", "C", "D", "E", "F"]))
        .describe('Course code -> grade letter, e.g. {"CSD3002": "A"}.'),
    },
    async ({ grades }) => {
      const history = parseGradeHistory(await client.getGradeHistoryHtml());
      const state = cgpaStateFrom(
        history.semesters.flatMap((s) => s.grades),
        history.cgpa,
        history.totalCredits,
      );
      const { courses } = await remainingCourses(client);
      const known = new Set(courses.map((c) => c.courseCode.toUpperCase()));
      const unknown = Object.keys(grades).filter(
        (code) => !known.has(code.toUpperCase()),
      );
      if (unknown.length > 0) {
        throw new Error(
          `Not a course you have left: ${unknown.join(", ")}. ` +
            "Use get_cgpa_target to see the courses still outstanding.",
        );
      }
      const normalised: Record<string, (typeof GRADE_SCALE)[number]["grade"]> = {};
      for (const [code, grade] of Object.entries(grades)) {
        const match = courses.find((c) => c.courseCode.toUpperCase() === code.toUpperCase());
        if (match) normalised[match.courseCode] = grade;
      }
      return {
        ...analyseDelta(state, courses, normalised),
        gradeScale: GRADE_SCALE.map((g) => `${g.grade}=${g.points}`),
        note:
          "Only the courses you named are included in the projection; the others are still " +
          "outstanding and their grades are unknown.",
      };
    },
  );

  mkJsonTool(
    server,
    "get_failed_courses_impact",
    "What each failed course is costing you, and what clearing it would buy. For every " +
      "failed course it reports your CGPA now, your CGPA if that course were not on the " +
      "record, and your CGPA if you re-register it and pass at the lowest passing grade " +
      "(D). Note the trap: re-registering adds the credits back into the denominator, so " +
      "clearing a backlog can LOWER your CGPA unless you pass well - the tool names the " +
      "grade that would actually help. Read-only. Requires login.",
    EmptySchema.shape,
    async () => {
      const history = parseGradeHistory(await client.getGradeHistoryHtml());
      const state = cgpaStateFrom(
        history.semesters.flatMap((s) => s.grades),
        history.cgpa,
        history.totalCredits,
      );
      const failed = history.semesters
        .flatMap((s) => s.grades)
        .filter((g) => g.grade === "F")
        .map((g) => ({
          courseCode: g.courseCode,
          courseName: g.courseName,
          credits: g.credits,
        }));
      return {
        currentCgpa: state.cgpa,
        gradedCredits: state.gradedCredits,
        failedCount: failed.length,
        impacts: failedCourseImpacts(state, failed, state.gradedCredits),
        note:
          "VIT makes you re-register a failed course, so its credits return to the " +
          "denominator as well as its points. A course is only worth re-taking if you " +
          "can score above the pass grade that keeps the CGPA moving up.",
      };
    },
  );

  mkJsonTool(
    server,
    "get_degree_summary",
    "The whole picture in one call: your CGPA, credits earned vs required, what is still " +
      "outstanding and from which basket, whether a target CGPA is still reachable, and the " +
      "next date that matters (your next exam, and when teaching ends). Start here for " +
      "'how far am I from finishing my degree?'. Read-only. Requires login.",
    {
      target: z
        .number()
        .min(0)
        .max(10)
        .optional()
        .describe("A target CGPA to test against (e.g. 8.5). Omit for the plain picture."),
    },
    async ({ target }) => {
      const semesterId = await client.getCurrentSemesterId();
      const [history, exams] = await Promise.all([
        client.getGradeHistoryHtml().then(parseGradeHistory),
        client.getExamScheduleHtml(semesterId).catch(() => null),
      ]);
      const state = cgpaStateFrom(
        history.semesters.flatMap((s) => s.grades),
        history.cgpa,
        history.totalCredits,
      );
      const { courses: remaining, creditsRequired, creditsRemaining } = await remainingCourses(client);

      // Credits still to earn, and where they sit.
      const byBasket = new Map<string, { count: number; credits: number }>();
      for (const c of remaining) {
        const key = c.category ?? "Uncategorised";
        const e = byBasket.get(key) ?? { count: 0, credits: 0 };
        e.count += 1;
        e.credits += c.credits;
        byBasket.set(key, e);
      }

      // Term bounds: when teaching ends, and whether attendance is locked.
      const today = istTodayISO();
      const bounds = await termBounds(
        client.getCalendar.bind(client),
        semesterId,
        today,
      );

      const examRows = exams
        ? parseExamSchedule(exams).map((e) => ({
            examType: e.examType,
            courseCode: e.courseCode,
            courseName: e.courseName,
            examDate: e.examDate,
            time: e.time,
          }))
        : [];
      const deadline = nextDeadline(examRows, today);

      const max = maxCgpa(state, remaining);
      const feasibility =
        target === undefined
          ? null
          : {
              targetCgpa: target,
              reachable: max >= target,
              alreadyMet: state.cgpa >= target,
              maxReachableCgpa: max,
              requiredAveragePoints: analyseTarget(state, remaining, target).requiredAveragePoints,
              mix: analyseTarget(state, remaining, target).mix,
            };

      return {
        today,
        cgpa: state.cgpa,
        credits: {
          gradedSoFar: state.gradedCredits,
          earnedSoFar: state.creditsEarned,
          required: creditsRequired,
          remainingCredits: creditsRemaining,
          remainingCourses: remaining.length,
        },
        outstanding: {
          courses: remaining.length,
          credits: creditsRemaining,
          byBasket: [...byBasket.entries()]
            .map(([category, e]) => ({ category, ...e }))
            .sort((a, b) => b.credits - a.credits),
        },
        target: feasibility,
        maxReachableCgpa: max,
        term: {
          lastInstructionalDay: bounds.lastInstructionalDay,
          teachingOver: bounds.teachingOver,
          attendanceLocked: bounds.teachingOver === true,
          instructionalDaysRemaining: bounds.instructionalDaysRemaining,
        },
        nextDeadline: deadline,
        note:
          "Outstanding credits come from the curriculum catalogue minus the courses you " +
          "have passed. 'maxReachableCgpa' assumes every remaining course scores S, so it " +
          "is the ceiling, not a prediction.",
      };
    },
  );
}
