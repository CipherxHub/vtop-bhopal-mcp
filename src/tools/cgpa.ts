import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VtopClient } from "../services/vtop-client.js";
import { VtopError } from "../services/errors.js";
import { parseCurriculumBaskets, parseGradeHistory } from "../services/vtop-parser.js";
import {
  analyseDelta,
  analyseTarget,
  cgpaStateFrom,
  failedCourseImpacts,
  GRADE_SCALE,
  type RemainingCourse,
} from "../services/cgpa-calc.js";
import { EmptySchema } from "../schemas/index.js";
import { mkJsonTool } from "./_helpers.js";

/**
 * The courses still to complete, with the credits each one carries.
 *
 * Credits come from the curriculum basket (the catalogue), not from the
 * timetable: the catalogue is the authority on how many credits a course is
 * worth, and it lists courses the student has not taken yet.
 */
async function remainingCourses(
  client: VtopClient,
): Promise<{ courses: RemainingCourse[]; source: string }> {
  const baskets = parseCurriculumBaskets(await client.getCurriculumBasketsHtml());
  if (baskets.length === 0) {
    throw new VtopError(
      "UPSTREAM",
      "VTOP returned a curriculum page with no recognisable course tables.",
      "The layout may have changed; the remaining-courses list cannot be built.",
    );
  }
  const history = parseGradeHistory(await client.getGradeHistoryHtml());
  const passed = new Set(
    history.semesters
      .flatMap((s) => s.grades)
      .filter((g) => g.grade && g.grade !== "F" && g.grade !== "N")
      .map((g) => g.courseCode.toUpperCase()),
  );
  const courses: RemainingCourse[] = [];
  for (const basket of baskets) {
    for (const course of basket.courses) {
      if (passed.has(course.code.toUpperCase())) continue;
      courses.push({
        courseCode: course.code,
        courseName: course.title,
        credits: course.credits,
        category: basket.category,
      });
    }
  }
  return { courses, source: "curriculum baskets minus grade-history passes" };
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
      const { courses, source } = await remainingCourses(client);
      const analysis = analyseTarget(state, courses, target);
      return {
        ...analysis,
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
}
