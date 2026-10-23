#!/usr/bin/env tsx
/**
 * Offline tests for the degree-completion maths.
 *   npm run test:cgpa
 *
 * The cases below are hand-computed. Each one states the arithmetic so a
 * future edit that changes the model shows up as a failing number, not as a
 * plausible-looking answer.
 */
import assert from "node:assert/strict";
import {
  analyseDelta,
  analyseTarget,
  cgpaStateFrom,
  maxCgpa,
  minCgpa,
  selectCoursesForBudget,
  type RemainingCourse,
} from "../src/services/cgpa-calc.js";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log("cgpa maths (offline)");

const course = (code: string, credits: number, name = code): RemainingCourse => ({
  courseCode: code,
  courseName: name,
  credits,
});

check("state comes from the grades, not from a flat average", () => {
  // 3 courses: A(4cr), B(3cr), F(2cr). Points 9*4 + 8*3 + 0*2 = 60 over
  // 9 graded credits -> 6.67. The F keeps its credits in the denominator.
  const state = cgpaStateFrom(
    [
      { grade: "A", gradePoints: 9, credits: 4 },
      { grade: "B", gradePoints: 8, credits: 3 },
      { grade: "F", gradePoints: 0, credits: 2 },
    ],
    null,
    7,
  );
  assert.equal(state.gradedCredits, 9);
  assert.equal(state.creditPoints, 60);
  assert.equal(state.cgpa, 6.67);
  assert.equal(state.creditsEarned, 7, "passed credits exclude the F");
});

check("P courses carry no points and no denominator", () => {
  // P(3cr) is a non-credit pass: it must not move the CGPA.
  const state = cgpaStateFrom(
    [
      { grade: "A", gradePoints: 9, credits: 4 },
      { grade: "P", gradePoints: 0, credits: 3 },
    ],
    null,
    4,
  );
  assert.equal(state.gradedCredits, 4);
  assert.equal(state.creditPoints, 36);
  assert.equal(state.cgpa, 9);
});

check("VTOP's own CGPA wins when both are available", () => {
  const state = cgpaStateFrom([{ grade: "A", gradePoints: 9, credits: 4 }], 8.1, 4);
  assert.equal(state.cgpa, 8.1);
});

check("the maximum is all-S over the remaining credits", () => {
  // 155 graded credits, 8.1 CGPA -> 1255.5 points. Three courses of 3 credits
  // left, all S: (1255.5 + 90) / 164 = 8.2039.
  const state = { gradedCredits: 155, creditPoints: 1255.5, cgpa: 8.1, creditsEarned: 155 };
  const max = maxCgpa(state, [course("A", 3), course("B", 3), course("C", 3)]);
  assert.equal(max, 8.2);
});

check("the minimum is all-F (the course is re-registered)", () => {
  // (1255.5 + 0) / 164 = 7.6561.
  const state = { gradedCredits: 155, creditPoints: 1255.5, cgpa: 8.1, creditsEarned: 155 };
  const min = minCgpa(state, [course("A", 3), course("B", 3), course("C", 3)]);
  assert.equal(min, 7.66);
});

check("an unreachable target is reported as unreachable", () => {
  // 8.1 -> 8.5 with 9 credits left cannot happen: even all-S gives 8.20.
  const state = { gradedCredits: 155, creditPoints: 1255.5, cgpa: 8.1, creditsEarned: 155 };
  const r = analyseTarget(state, [course("A", 3), course("B", 3), course("C", 3)], 8.5);
  assert.equal(r.unreachable, true);
  assert.equal(r.requiredAveragePoints, null);
  assert.equal(r.mix, null);
  assert.equal(r.maxCgpa, 8.2);
});

check("a reachable target reports the average and a concrete mix", () => {
  // 155 credits at 8.1, four courses of 3 credits left (12 credits).
  // All-S: (1255.5 + 120)/167 = 8.234. 8.3 is not reachable; 8.2 is.
  const state = { gradedCredits: 155, creditPoints: 1255.5, cgpa: 8.1, creditsEarned: 155 };
  const remaining = [course("A", 3), course("B", 3), course("C", 3), course("D", 3)];
  const r = analyseTarget(state, remaining, 8.2);
  assert.equal(r.unreachable, false);
  assert.ok(r.requiredAveragePoints !== null);
  // Average needed: 8.2 - (1255.5 - 8.2*155)/12 = 8.2 - (-15.5)/12 = 9.49.
  assert.equal(r.requiredAveragePoints, 9.49);
  assert.ok(r.mix, "a mix must be offered");
  const total = r.mix.reduce((s, m) => s + m.count, 0);
  assert.equal(total, 4, "every course appears in the mix");
  // The mix's contribution is grade points x CREDITS (each course carries
  // its own weight), not points x count.
  const mixPoints = r.mix.reduce(
    (s, m) => s + m.credits * ({ S: 10, A: 9, B: 8, C: 7, D: 6, E: 5, F: 0 }[m.grade] ?? 0),
    0,
  );
  const projected = Math.round(((1255.5 + mixPoints) / 167) * 100) / 100;
  assert.ok(projected >= 8.2, `the mix must reach the target, got ${projected}`);
});

check("the mix is not flatter than it has to be", () => {
  // The mix should keep as many top grades as the target allows.
  const state = { gradedCredits: 100, creditPoints: 800, cgpa: 8, creditsEarned: 100 };
  const remaining = [course("A", 4), course("B", 4), course("C", 4)];
  const r = analyseTarget(state, remaining, 8.2);
  assert.ok(r.mix);
  const sCount = r.mix.find((m) => m.grade === "S")?.count ?? 0;
  assert.ok(sCount >= 2, `expected the top grades kept, mix=${JSON.stringify(r.mix)}`);
});

check("a target already met is reported as met", () => {
  const state = { gradedCredits: 100, creditPoints: 850, cgpa: 8.5, creditsEarned: 100 };
  const r = analyseTarget(state, [course("A", 3)], 8.5);
  assert.equal(r.alreadyMet, true);
  assert.equal(r.unreachable, false);
});

check("no remaining courses: met or unreachable, never a fake mix", () => {
  const state = { gradedCredits: 100, creditPoints: 800, cgpa: 8, creditsEarned: 100 };
  const r = analyseTarget(state, [], 8.5);
  assert.equal(r.unreachable, true);
  assert.equal(r.mix, null);
});

check("the catalogue is trimmed to the credit budget, not taken at face value", () => {
  // The programme catalogue lists every elective option (31 courses when the
  // degree needs 24 credits of them). Taking "catalogue minus passed" as the
  // outstanding list overstated the remaining work 180 credits against a real
  // 74 — and with it the maximum reachable CGPA.
  const candidates = [
    { courseCode: "AAA", courseName: "A", credits: 4, category: "Programme Core" },
    { courseCode: "BBB", courseName: "B", credits: 4, category: "Programme Core" },
    { courseCode: "CCC", courseName: "C", credits: 4, category: "Programme Core" },
    { courseCode: "DDD", courseName: "D", credits: 4, category: "Programme Elective" },
    { courseCode: "EEE", courseName: "E", credits: 40, category: "Project" },
  ];
  const chosen = selectCoursesForBudget(candidates, 12);
  assert.equal(chosen.length, 3, "12 credits buys three 4-credit courses");
  assert.equal(chosen.reduce((s, c) => s + c.credits, 0), 12);
  // A course that does not fit is skipped, not overshot.
  const mixed = selectCoursesForBudget(
    [
      { courseCode: "BIG", courseName: "B", credits: 40, category: "P" },
      { courseCode: "S1", courseName: "S", credits: 4, category: "C" },
      { courseCode: "S2", courseName: "S", credits: 4, category: "C" },
      { courseCode: "S3", courseName: "S", credits: 4, category: "C" },
    ],
    12,
  );
  assert.equal(mixed.reduce((s, c) => s + c.credits, 0), 12);
  assert.ok(!mixed.some((c) => c.courseCode === "BIG"), "the 40-credit course does not fit a 12-credit budget");
});

check("a budget that cannot be fully spent leaves the remainder unspent", () => {
  const chosen = selectCoursesForBudget(
    [
      { courseCode: "S1", courseName: "S", credits: 4, category: "C" },
      { courseCode: "S2", courseName: "S", credits: 4, category: "C" },
    ],
    12,
  );
  assert.equal(chosen.length, 2);
  assert.equal(chosen.reduce((s, c) => s + c.credits, 0), 8, "8 of the 12 credits are spendable");
});

check("the delta reports the change and the range", () => {
  // 155 credits at 8.1 (1255.5 points), two courses of 3 credits.
  // A + A: each contributes 9 points x 3 credits = 27 -> (1255.5 + 54)/161
  // = 8.1335 -> 8.13, i.e. +0.03 (an A on 3 credits is a small move).
  const state = { gradedCredits: 155, creditPoints: 1255.5, cgpa: 8.1, creditsEarned: 155 };
  const remaining = [course("A", 3), course("B", 3)];
  const d = analyseDelta(state, remaining, { A: "A", B: "A" });
  assert.equal(d.projectedCgpa, 8.13);
  assert.equal(d.change, 0.03);
  assert.equal(d.applied.length, 2);
  // All-S on the same two: (1255.5 + 60)/161 = 8.168.
  assert.equal(d.ifAllS, 8.17);
  // All-F: (1255.5 + 0)/161 = 7.798.
  assert.equal(d.ifAllF, 7.8);
});

check("a named course that is not outstanding is rejected upstream", () => {
  // (the tool checks this; the maths simply ignores unknown codes)
  const state = { gradedCredits: 100, creditPoints: 800, cgpa: 8, creditsEarned: 100 };
  const d = analyseDelta(state, [course("A", 3)], { ZZZ: "A" });
  assert.equal(d.applied.length, 0);
  assert.equal(d.projectedCgpa, 8);
});

console.log(`\n${passed} checks passed.`);
