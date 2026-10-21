#!/usr/bin/env tsx
/**
 * Offline tests for the pass-eligibility rules.
 *   npm run test:exam
 *
 * The invariant that matters: passing is 80 raw marks out of 200, and whatever
 * a CAT falls short by is transferred onto the FAT — so the raw total is
 * conserved at exactly 80 no matter how the CATs went. Most tests below check
 * that conservation directly rather than restating expected numbers.
 */
import assert from "node:assert/strict";
import {
  CAT_PASS_RAW,
  FAT_BASE_RAW,
  FAT_MAX_RAW,
  RAW_PASS_TOTAL,
  RAW_TOTAL_AVAILABLE,
  ATTENDANCE_GATE_PERCENT,
  catDeficit,
  requiredFatRaw,
  rawTotalPasses,
  weightedMarks,
  assessCat,
  assessCourse,
  attendanceRunway,
  sessionsBefore,
} from "../src/services/exam-eligibility.js";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    throw err;
  }
}

const cat = (label: string, raw: number | null) => ({ label, raw });

console.log("pass-eligibility rules (offline)");

// --- the headline numbers --------------------------------------------------
check("passing is 80 raw marks out of 200 available", () => {
  assert.equal(RAW_PASS_TOTAL, 80);
  assert.equal(RAW_TOTAL_AVAILABLE, 200); // 50 + 50 + 100
  assert.equal(RAW_PASS_TOTAL, CAT_PASS_RAW * 2 + FAT_BASE_RAW);
});

check("FAT base requirement is 40 of 100", () => {
  assert.equal(FAT_BASE_RAW, 40);
  assert.equal(FAT_MAX_RAW, 100);
});

// --- deficit transfer ------------------------------------------------------
check("a CAT at the 20 minimum has no deficit", () => {
  assert.equal(catDeficit([20, 20]), 0);
  assert.equal(requiredFatRaw([20, 20]), 40, "both at 20 -> FAT >= 40");
});

check("a CAT scoring 10 alongside a perfect one still transfers 10", () => {
  // 20 + 10 = 30 combined, against the 40 the two need -> 10 short.
  assert.equal(catDeficit([20, 10]), 10);
  assert.equal(requiredFatRaw([20, 10]), 50);
});

// --- the offset cases: these are what the per-CAT version got wrong --------
check("a CAT above 20 OFFSETS one below it (30 / 10 needs no extra)", () => {
  // 30 + 10 = 40 combined, which is exactly what the two CATs must
  // contribute. Nothing is transferred, so the FAT stays at 40 and the raw
  // total is 80. Summing shortfalls per-CAT would wrongly demand 50.
  assert.equal(catDeficit([30, 10]), 0);
  assert.equal(requiredFatRaw([30, 10]), 40);
  assert.equal(30 + 10 + 40, RAW_PASS_TOTAL, "raw total must be exactly 80");
});

check("a large surplus wipes out a shortfall entirely", () => {
  assert.equal(catDeficit([45, 10]), 0);
  assert.equal(requiredFatRaw([45, 10]), 40);
  assert.equal(45 + 10 + 40, 95, "above 80 because the CATs exceeded 40");
});

check("partial offset: 25 / 5 is 30 combined, 10 short", () => {
  assert.equal(catDeficit([25, 5]), 10);
  assert.equal(requiredFatRaw([25, 5]), 50);
});

check("surplus is only usable against a shortfall, never negative", () => {
  assert.equal(catDeficit([50, 50]), 0);
  assert.equal(catDeficit([50, 50]), Math.max(0, 40 - 100));
});

check("the student's worked example: 10 and 10 -> FAT >= 60", () => {
  assert.equal(requiredFatRaw([10, 10]), 60);
  // And that really does land the raw total on 80.
  const total = 10 + 10 + 60;
  assert.equal(total, RAW_PASS_TOTAL);
});

check("an unattempted CAT counts as 0, so the full 20 transfers", () => {
  assert.equal(catDeficit([null, 0]), 40, "neither attempted -> full 40 transfers");
  assert.equal(catDeficit([null, 20]), 20, "CAT-1 missed, CAT-2 at 20");
  assert.equal(requiredFatRaw([null, 20]), 60, "CAT-1 missed, CAT-2 at 20");
  assert.equal(requiredFatRaw([null, null]), 80, "neither attempted");
});

check("scoring ABOVE 20 never raises the FAT bar", () => {
  assert.equal(catDeficit([45, 40]), 0);
  assert.equal(requiredFatRaw([45, 40]), 40, "strong CATs keep the base 40");
});

check("19 and 19 each transfer 1 mark", () => {
  assert.equal(requiredFatRaw([19, 19]), 42);
  assert.equal(19 + 19 + 42, RAW_PASS_TOTAL, "total still exactly 80");
});

// --- conservation: the rule's real property --------------------------------
check("raw total is conserved at exactly 80 whenever the CATs total 40 or less", () => {
  for (let c1 = 0; c1 <= 40; c1++) {
    for (let c2 = 0; c2 + c1 <= 40; c2++) {
      const fat = requiredFatRaw([c1, c2]);
      const total = c1 + c2 + fat;
      assert.equal(
        total,
        RAW_PASS_TOTAL,
        `CATs ${c1}/${c2} gave FAT ${fat} and a raw total of ${total}`,
      );
    }
  }
});

check("raw total exceeds 80 only when the CATs exceed 40 combined", () => {
  for (let c1 = 0; c1 <= 50; c1++) {
    for (let c2 = 0; c2 <= 50; c2++) {
      const sum = c1 + c2;
      const fat = requiredFatRaw([c1, c2]);
      const total = sum + fat;
      const expected = Math.max(RAW_PASS_TOTAL, sum + FAT_BASE_RAW);
      assert.equal(
        total,
        expected,
        `CATs ${c1}/${c2} gave FAT ${fat} and a raw total of ${total}`,
      );
    }
  }
});

check("a strong CAT exactly covers a zero on the other (40 / 0)", () => {
  // 40 + 0 = 40 combined, exactly what the two CATs must contribute, so no
  // deficit transfers and the FAT needs only its base 40.
  assert.equal(catDeficit([40, 0]), 0);
  assert.equal(requiredFatRaw([40, 0]), 40);
  assert.equal(40 + 0 + 40, RAW_PASS_TOTAL);
});

check("but 39 / 0 IS one short, and the FAT carries it", () => {
  assert.equal(catDeficit([39, 0]), 1);
  assert.equal(requiredFatRaw([39, 0]), 41);
  assert.equal(39 + 0 + 41, RAW_PASS_TOTAL);
});

check("a deficit never reduces the requirement below the 40 base", () => {
  assert.ok(requiredFatRaw([50, 50]) >= FAT_BASE_RAW);
  assert.equal(requiredFatRaw([20, 20]), FAT_BASE_RAW);
});

check("more deficit can only ever raise the FAT bar", () => {
  assert.ok(requiredFatRaw([10, 10]) > requiredFatRaw([15, 15]));
  assert.ok(requiredFatRaw([15, 15]) > requiredFatRaw([20, 20]));
});

// --- the equivalent 80-of-200 formulation ----------------------------------
check("rawTotalPasses agrees with the FAT-threshold rule", () => {
  const cases: [number | null, number | null, number][] = [
    [20, 20, 40],
    [20, 20, 39],
    [10, 10, 60],
    [10, 10, 59],
    [null, 20, 60],
    [null, null, 80],
    [45, 40, 40],
    [0, 0, 80],
  ];
  for (const [c1, c2, fat] of cases) {
    const byTotal = rawTotalPasses([c1, c2], fat);
    const byFat = fat >= requiredFatRaw([c1, c2]);
    assert.equal(byTotal, byFat, `CATs ${c1}/${c2}, FAT ${fat} disagreed`);
  }
});

check("exactly 80 raw passes, 79 does not", () => {
  assert.equal(rawTotalPasses([20, 20], 40), true);
  assert.equal(rawTotalPasses([20, 20], 39), false);
});

// --- individual CAT --------------------------------------------------------
check("CAT at exactly 20/50 passes", () => {
  const v = assessCat(cat("CAT-I", 20));
  assert.equal(v.status, "passed");
  assert.equal(v.marks, 6); // 20/50 * 15
  assert.equal(v.ownShortfall, 0);
});

check("CAT at 19/50 fails, scores nothing, and owes 1 to the FAT", () => {
  const v = assessCat(cat("CAT-I", 19));
  assert.equal(v.status, "failed");
  assert.equal(v.marks, 0);
  assert.equal(v.ownShortfall, 1);
});

check("a CAT with no mark is 'missed' and owes the full 20", () => {
  const v = assessCat(cat("CAT-I", null));
  assert.equal(v.status, "missed");
  assert.equal(v.marks, 0);
  assert.equal(v.ownShortfall, 20);
});

check("scored 0 is a FAILED attempt, not a MISSED one", () => {
  // VTOP publishes a row for an attempt even when the score is zero, so 0 is
  // distinguishable from "no row at all". Both fall 20 short on their own, but
  // only an unattempted CAT is irrecoverable. Note these are the PER-CAT
  // shortfalls; whether they reach the FAT depends on the other CAT.
  const scored = assessCat(cat("CAT-I", 0));
  assert.equal(scored.status, "failed");
  assert.equal(scored.ownShortfall, 20);
  const unattempted = assessCat(cat("CAT-I", null));
  assert.equal(unattempted.status, "missed");
  assert.equal(unattempted.ownShortfall, 20);
});

check("a failed and a missed CAT owe the SAME deficit", () => {
  // Both fell short of 20; only the attempt differs. There is no re-test, so
  // neither can be recovered — the difference is not in the arithmetic.
  assert.equal(assessCat(cat("CAT-I", 0)).ownShortfall, assessCat(cat("CAT-I", null)).ownShortfall);
});

// --- whole-course verdicts -------------------------------------------------
check("all gates met -> canPass true", () => {
  const r = assessCourse([cat("CAT-I", 25), cat("CAT-II", 22)], 45, {
    scoredSoFar: 35,
    attendancePercent: 86,
  });
  assert.equal(r.canPass, true);
  assert.equal(r.teeRequiredRaw, 40);
  assert.equal(r.totalDeficit, 0);
  assert.deepEqual(r.blockers, []);
});

check("10 and 10 then a 45 FAT still FAILS (needs 60)", () => {
  const r = assessCourse([cat("CAT-I", 10), cat("CAT-II", 10)], 45, {
    scoredSoFar: 35,
    attendancePercent: 86,
  });
  assert.equal(r.canPass, false);
  assert.equal(r.teeRequiredRaw, 60);
  assert.match(r.blockers.join(" "), /45\/100 is below the 60 needed/);
});

check("CATs under 20 owe their shortfall but are not themselves a blocker", () => {
  // This is the distinction that matters and is easy to get wrong: the CAT
  // gate is "20 needed", not "20 mandatory". Scoring 10 does not fail you — it
  // moves 10 marks of requirement onto the FAT. Only the shortfall reaches
  // 80 raw if the FAT then makes it up.
  const r = assessCourse([cat("CAT-I", 10), cat("CAT-II", 10)], 60, {
    scoredSoFar: 30,
    attendancePercent: 90,
  });
  assert.equal(r.canPass, true, "the raw total reaches 80, so this passes");
  assert.equal(r.rawTotalSoFar, 80);
  assert.deepEqual(r.blockers, [], "a sub-20 CAT is not itself a blocker");
});

check("an unattempted CAT is called out loudly but is recoverable via the TEE", () => {
  // VIT's rule, confirmed by the maintainer: a missed CAT is a 20-mark hole
  // like any other shortfall — the course still passes if the TEE makes the
  // total up to 80. It used to be reported as a hard blocker while the same
  // payload said "you can make it up in the TEE" and showed 80/80 raw.
  const r = assessCourse([cat("CAT-I", null), cat("CAT-II", 20)], 60, {
    scoredSoFar: 30,
    attendancePercent: 90,
  });
  assert.equal(r.missedCats, 1);
  assert.match(r.advisories.join(" "), /not attempted/);
  assert.match(r.advisories.join(" "), /no re-test/i);
  assert.deepEqual(r.blockers, [], "the TEE can absorb the missed CAT's share");
  assert.equal(r.canPass, true, "60 TEE + 20 CAT-II reaches the 80 raw bar");
  assert.equal(r.teeRequiredRaw, 60);
  assert.equal(r.rawTotalSoFar, 80);
  assert.equal(r.rawTotalRequired, 80);
});

check("both CATs missed still passes when the TEE makes up the total", () => {
  // 0 + 0 + 80 = 80 raw: the bar is met, so the course passes.
  const r = assessCourse([cat("CAT-I", null), cat("CAT-II", null)], 80, {
    scoredSoFar: 0,
    attendancePercent: 90,
  });
  assert.equal(r.teeRequiredRaw, 80);
  assert.equal(r.rawTotalSoFar, 80);
  assert.equal(r.canPass, true);
  assert.equal(r.advisories.length, 2, "both misses are called out");
});

check("a missed CAT fails the course when the TEE cannot make it up", () => {
  // 0 + 20 + 40 = 60 raw: short of 80, so the course is failed (and VIT
  // makes the student re-register it). The TEE bar says 60 was needed.
  const r = assessCourse([cat("CAT-I", null), cat("CAT-II", 20)], 40, {
    scoredSoFar: 30,
    attendancePercent: 90,
  });
  assert.equal(r.teeRequiredRaw, 60);
  assert.equal(r.rawTotalSoFar, 60);
  assert.equal(r.canPass, false);
  assert.match(r.blockers.join(" "), /below the 60 needed/);
});

check("a CAT scored 0 is the same arithmetic as a missed one", () => {
  // Attempted-and-zero and not-attempted are both 20-mark holes; only the
  // reason differs, and both are recoverable in the TEE.
  const scored = assessCourse([cat("CAT-I", 0), cat("CAT-II", 20)], 60, {
    scoredSoFar: 30,
    attendancePercent: 90,
  });
  const missed = assessCourse([cat("CAT-I", null), cat("CAT-II", 20)], 60, {
    scoredSoFar: 30,
    attendancePercent: 90,
  });
  assert.equal(scored.teeRequiredRaw, missed.teeRequiredRaw);
  assert.equal(scored.canPass, missed.canPass);
  assert.equal(scored.canPass, true);
});

check("a missed CAT the TEE cannot absorb IS a hard blocker", () => {
  // Two CATs cap the TEE requirement at 80 (inside the 100-mark paper), so
  // the blocker branch is unreachable in practice — it exists for the case
  // where a third component changes the arithmetic. Guard it directly.
  const r = assessCourse([cat("CAT-I", null), cat("CAT-II", null)], 80, {
    scoredSoFar: 0,
    attendancePercent: 90,
  });
  assert.equal(r.missedCats, 2);
  assert.deepEqual(r.blockers, [], "80/100 TEE still absorbs both missed CATs");
  assert.equal(r.teeRequiredRaw, 80);
});

check("a CAT scored 0 is an attempt, so not a blocker even though it owes 20", () => {
  const r = assessCourse([cat("CAT-I", 0), cat("CAT-II", 20)], 60, {
    scoredSoFar: 30,
    attendancePercent: 90,
  });
  assert.equal(r.missedCats, 0);
  assert.deepEqual(r.blockers, [], "an attempt at 0 is recoverable via the TEE");
  assert.match(r.advisories.join(" "), /CAT-I scored 0/);
});

check("a missed CAT transfers only its NET share of the shortfall", () => {
  // CAT-I unattempted (0) + CAT-II 25 = 25 combined, against the 40 needed ->
  // 15 transfers, not the full 20. CAT-II's 5-mark surplus absorbs 5 of it.
  const r = assessCourse([cat("CAT-I", null), cat("CAT-II", 25)], 90, {
    scoredSoFar: 35,
    attendancePercent: 90,
  });
  assert.equal(r.teeRequiredRaw, 55);
  assert.equal(r.totalDeficit, 15);
  assert.equal(r.missedCats, 1);
  assert.match(r.advisories.join(" "), /not attempted/);
  assert.match(r.advisories.join(" "), /no re-test/i);
});

check("a missed CAT with a weak partner transfers more", () => {
  // CAT-I unattempted (0) + CAT-II 10 = 10 combined -> 30 transfers.
  const r = assessCourse([cat("CAT-I", null), cat("CAT-II", 10)], 80, {
    scoredSoFar: 35,
    attendancePercent: 90,
  });
  assert.equal(r.teeRequiredRaw, 70);
  assert.equal(r.totalDeficit, 30);
});

check("unpassed yet -> canPass is null, not false", () => {
  const r = assessCourse([cat("CAT-I", 30), cat("CAT-II", 30)], null, {
    scoredSoFar: 35,
    attendancePercent: 80,
  });
  assert.equal(r.canPass, null, "FAT not taken yet is not a failure");
  assert.equal(r.teeMarks, null);
  assert.equal(r.rawTotalSoFar, null);
});

check("attendance below 75 blocks exam eligibility", () => {
  const r = assessCourse([cat("CAT-I", 30), cat("CAT-II", 30)], 80, {
    scoredSoFar: 35,
    attendancePercent: 74.9,
  });
  assert.equal(r.canPass, false);
  assert.match(r.blockers.join(" "), /Attendance 74\.9% is below the 75%/);
});

check("exactly 75% attendance still qualifies", () => {
  const r = assessCourse([cat("CAT-I", 30), cat("CAT-II", 30)], 80, {
    scoredSoFar: 35,
    attendancePercent: 75,
  });
  assert.equal(r.canPass, true);
  assert.equal(ATTENDANCE_GATE_PERCENT, 75);
});

check("minimum total to pass = everything scored so far + FAT at its threshold", () => {
  // scoredSoFar is the 100-scale sum of every PUBLISHED component, so the
  // CAT-I 6 and CAT-II 6 are already inside the 35. The only thing still to
  // come is the FAT at its 40/100 minimum, worth 12.
  const r = assessCourse([cat("CAT-I", 20), cat("CAT-II", 20)], null, {
    scoredSoFar: 35,
  });
  assert.equal(r.catMarks, 12);
  assert.equal(r.teeRequiredMarks, 12);
  assert.equal(r.totalIfTeeClearedAtMinimum, 47);
});

check("the CAT marks are NOT double-counted in the minimum total", () => {
  // Regression test: the total was once computed as scoredSoFar + catMarks +
  // fat, which counted the CATs twice. For a course that had already published
  // 58.0 of its 100-point scale, of which 24.0 came from the two CATs, that
  // overstated the requirement as 94 instead of 70.0.
  const r = assessCourse([cat("CAT-I", 31), cat("CAT-II", 26)], null, {
    scoredSoFar: 58.0,
  });
  assert.equal(r.catMarks, 17.1, "the CATs contributed 17.1 of the 58.0");
  assert.equal(r.teeRequiredMarks, 12);
  assert.equal(
    r.totalIfTeeClearedAtMinimum,
    70.0,
    "58.0 + 12 FAT, with the CATs counted once inside the 58.0",
  );
});

check("a CAT shortfall raises the minimum total too", () => {
  // CAT-I 10 gives a 10-mark deficit, so the FAT must reach 50/100 = 15.
  const r = assessCourse([cat("CAT-I", 10), cat("CAT-II", 20)], null, {
    scoredSoFar: 35,
  });
  assert.equal(r.teeRequiredMarks, 15);
  assert.equal(r.totalIfTeeClearedAtMinimum, 50);
});

check("unknown internal marks -> no 100-scale total, but gates still evaluate", () => {
  const r = assessCourse([cat("CAT-I", 25), cat("CAT-II", 25)], 50, {
    scoredSoFar: null,
  });
  assert.equal(r.totalIfTeeClearedAtMinimum, null);
  assert.equal(r.canPass, true);
});

check("the explanation states the 80-of-200 rule and the live FAT bar", () => {
  const r = assessCourse([cat("CAT-I", 10), cat("CAT-II", 10)], null, {
    scoredSoFar: 30,
  });
  assert.match(r.explanation, /80 raw marks out of 200/);
  assert.match(r.explanation, /it must reach 60 here \(40 base \+ 20 carried/);
  assert.match(r.explanation, /Each CAT is a 50-mark paper needing 20, and that minimum is worth 6 of the 15/);
  assert.match(r.explanation, /TEE is a 100-mark paper worth 30 of 100/);
});

// --- attendance runway -----------------------------------------------------
check("no upcoming classes -> the cushion is reported, nothing to skip", () => {
  // 31/36 = 86.1%. With no classes left you cannot skip any, so skippable is
  // 0 — but the standing cushion (31 - 0.75*36 = 4) still says how much
  // margin you hold, and mustAttend is 0 (nothing needed), not null.
  const r = attendanceRunway({ attended: 31, total: 36 }, 0);
  assert.equal(r.percent, 86.11);
  assert.equal(r.skippable, 0, "no classes left to skip");
  assert.equal(r.standingCushion, 4, "the margin you still hold");
  assert.equal(r.mustAttend, 0, "nothing to attend: already safe");
  assert.equal(r.mustAttendUnreachable, false);
  assert.equal(r.eligibleAtDeadline, true);
});

check("skippable never exceeds the classes that exist", () => {
  // A big cushion must not promise skips on days that are not on the
  // calendar: 90/100 with 2 classes left can only skip 2.
  const r = attendanceRunway({ attended: 90, total: 100 }, 2);
  assert.equal(r.skippable, 2);
  assert.equal(r.standingCushion, 15);
  assert.equal(r.mustAttend, 0);
});

check("mustAttend is null only when the deadline is unreachable", () => {
  // 10/100 with 5 classes left: attending all five reaches 15/105 = 14.3%, so
  // no number of classes can restore 75% — null plus the explicit flag.
  const unreachable = attendanceRunway({ attended: 10, total: 100 }, 5);
  assert.equal(unreachable.mustAttend, null);
  assert.equal(unreachable.mustAttendUnreachable, true);
  // 80/100 with 20 left: (80 + x)/120 >= 0.75 -> x >= 10, and 20 exist.
  const reachable = attendanceRunway({ attended: 80, total: 100 }, 20);
  assert.equal(reachable.mustAttend, 10);
  assert.equal(reachable.mustAttendUnreachable, false);
});

check("the 75% gate uses the raw ratio, not the rounded display value", () => {
  // 74.996% must not pass a >= 75 gate just because it prints as "75".
  const r = attendanceRunway({ attended: 18749, total: 25000 }, 0);
  assert.equal(r.percent, 75, "prints as 75");
  assert.equal(r.eligibleNow, false, "but the raw ratio is below the gate");
});

check("skippable allows misses while staying at or above 75%", () => {
  // 31/36 with 20 classes left: (31 + 20 - s)/(56) >= 0.75 -> s <= 9.
  const r = attendanceRunway({ attended: 31, total: 36 }, 20);
  assert.equal(r.skippable, 9);
  const { attended: a, total: t } = r;
  const u = 20, s = r.skippable;
  assert.ok((a + (u - s)) / (t + u) >= 0.75, "skipping exactly skippable stays eligible");
  assert.ok((a + (u - (s + 1))) / (t + u) < 0.75, "one more skip breaks the gate");
});

check("already below 75 -> must attend to recover, but skips remain", () => {
  // 8/11 = 72.7%. With 10 classes left: attend x -> (8+x)/21 >= 0.75 -> x >= 8.
  // Skipping s: (8 + 10 - s)/21 >= 0.75 -> s <= 2.
  const r = attendanceRunway({ attended: 8, total: 11 }, 10);
  assert.equal(r.eligibleNow, false);
  assert.equal(r.mustAttend, 8);
  assert.equal(r.skippable, 2);
});

check("no recovery possible -> skippable 0 and ineligible at the deadline", () => {
  const r = attendanceRunway({ attended: 1, total: 10 }, 0);
  assert.equal(r.skippable, 0);
  assert.equal(r.eligibleNow, false);
  assert.equal(r.eligibleAtDeadline, false);
});

check("skippable is never negative", () => {
  assert.equal(attendanceRunway({ attended: 0, total: 10 }, 0).skippable, 0);
});

check("percentIfSkipAll shows the worst case at the deadline", () => {
  const r = attendanceRunway({ attended: 31, total: 36 }, 20);
  assert.equal(r.percentIfSkipAll, 55.36); // 31/56
  assert.equal(r.eligibleAtDeadline, false, "skipping everything loses eligibility");
});

// --- both scales, always ---------------------------------------------------
// The student asked to be told every threshold in BOTH scales: the marks on
// the paper, and what that is worth on the 100-point course scale. These pin
// that mapping so a future edit cannot quietly drop one of the two.
check("a CAT threshold is reported in both scales", () => {
  const v = assessCat(cat("CAT-I", 25));
  assert.equal(v.neededRaw, 20, "20 on the 50-mark paper");
  assert.equal(v.rawMax, 50);
  assert.equal(v.neededMarks, 6, "worth 6 of the 15 that CAT carries");
  assert.match(v.requirement, /20\/50 raw, worth 6 of the 15 marks/);
});

check("the TEE threshold is reported in both scales", () => {
  const r = assessCourse([cat("CAT-I", 30), cat("CAT-II", 30)], null, {
    scoredSoFar: 40,
  });
  assert.equal(r.teeRequiredRaw, 40, "40 on the 100-mark paper");
  assert.equal(r.teeRawMax, 100);
  assert.equal(r.teeRequiredMarks, 12, "worth 12 of the 30 the TEE carries");
  assert.match(r.teeRequirement, /40\/100 on the TEE paper, worth 12 of the 30/);
});

check("a raised TEE threshold is converted on the weighted scale too", () => {
  // CATs 10 and 10 -> 20 short -> TEE must reach 60/100, which is 60% of the
  // 30 available TEE marks, i.e. 18.
  const r = assessCourse([cat("CAT-I", 10), cat("CAT-II", 10)], null, {
    scoredSoFar: 30,
  });
  assert.equal(r.teeRequiredRaw, 60);
  assert.equal(r.teeRequiredMarks, 18);
  assert.match(r.teeRequirement, /60\/100 on the TEE paper, worth 18 of the 30/);
});

check("the two scales are the same fraction of their maxima", () => {
  for (const [raw, marks] of [[40, 12], [50, 15], [60, 18], [80, 24]] as const) {
    assert.equal(
      raw / 100,
      marks / 30,
      `${raw}/100 and ${marks}/30 must be the same fraction`,
    );
  }
});

check("the projected total is banked + TEE, not a requirement to score", () => {
  const r = assessCourse([cat("CAT-I", 31), cat("CAT-II", 26)], null, {
    scoredSoFar: 58.0,
  });
  assert.equal(r.bankedSoFar, 58.0, "everything published so far");
  assert.equal(r.teeRequiredMarks, 12);
  assert.equal(
    r.totalIfTeeClearedAtMinimum,
    70.0,
    "58.0 banked + 12 from the TEE - an outcome, not something to aim for",
  );
});

// --- teaching over is a real state, not an unknown one ---------------------
// The Fall 2026-27 calendar shows teaching ended 2026-10-12 and every day
// after that is a Term End Examination. Zero remaining classes is therefore a
// fact about the semester, and must never be conflated with "the calendar
// could not be read".
check("a runway past the last instructional day has nothing left to attend", () => {
  // 31/36 = 86.1% with zero classes remaining: the cushion simply stands.
  const r = attendanceRunway({ attended: 31, total: 36 }, 0);
  assert.equal(r.upcomingClasses, 0);
  assert.equal(r.skippable, 0, "no classes left to skip");
  assert.equal(r.standingCushion, 4, "but the margin you still hold");
  assert.equal(r.mustAttend, 0, "nothing to attend: already safe");
  assert.equal(r.mustAttendUnreachable, false);
  assert.equal(r.percentIfSkipAll, r.percent, "nothing left to skip");
  assert.equal(r.eligibleAtDeadline, true);
});

// --- sessionsBefore: normal weekdays count, overrides respected ------------
check("sessionsBefore counts normal weekdays without a day-order override", () => {
  // 2026-10-12 is a Monday. dayOrderWeekday null means a normal day.
  const n = sessionsBefore(
    ["MON"],
    [{ date: "2026-10-12", instructional: true, dayOrderWeekday: null }],
    "2026-10-12",
    "2026-10-19",
  );
  assert.equal(n, 1);
});

check("sessionsBefore respects a working-Saturday day-order override", () => {
  const n = sessionsBefore(
    ["MON"],
    [{ date: "2026-12-12", instructional: true, dayOrderWeekday: "MON" }],
    "2026-12-12",
    "2026-12-12",
  );
  assert.equal(n, 1);
});

check("sessionsBefore skips non-instructional and out-of-range days", () => {
  const n = sessionsBefore(
    ["MON"],
    [
      { date: "2026-10-12", instructional: false, dayOrderWeekday: null },
      { date: "2026-10-19", instructional: true, dayOrderWeekday: null },
    ],
    "2026-10-12",
    "2026-10-12",
  );
  assert.equal(n, 0);
});

console.log(`\n${passed} checks passed.`);