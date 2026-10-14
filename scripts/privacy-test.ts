#!/usr/bin/env tsx
/**
 * Fixture hygiene guard.
 *   npm run test:privacy
 *
 * This repository is published, so no committed file may contain a real
 * student's data. Tests genuinely need realistic SHAPE — the field names, the
 * leaveCode values, the column order, the date formats — because none of that
 * can be guessed. They do NOT need real VALUES.
 *
 * That distinction is easy to lose while debugging a parser against a captured
 * response, which is exactly how real identifiers ended up in fixtures once
 * before. This test fails the build if identifiable data reappears, so the
 * mistake cannot recur silently.
 *
 * It deliberately matches PATTERNS rather than a blocklist of known strings:
 * a blocklist only catches the exact values that were leaked before, and would
 * happily pass a fresh leak.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

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

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  "node_modules", "dist", ".git", "tmp-caldebug", "tmp-leaveprobe",
  "tmp-vtopdump", "test-output", "coverage",
]);
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".yaml", ".yml",
  ".html", ".txt", ".example", "",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (TEXT_EXT.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(ROOT).filter((f) => {
  // Lockfiles and the licence texts are generated/vendored, not authored here.
  const base = path.basename(f);
  return base !== "package-lock.json";
});

/**
 * Deliberately fake identifiers, allowed to exist and matched by the rules
 * below. Listing them is the point: the patterns stay strict enough to catch
 * anything NEW, while fixtures keep the shape of a real record (a leave id
 * that does not look like a leave id would not test the parser).
 *
 * Anyone adding a fixture must add its fake ids here, which is a deliberate
 * extra step rather than an accident.
 */
const SYNTHETIC = new Set([
  "L9000001", "L9000002", "L9000003", "L1234567",
  "9000001", // sample proctor staff id
  "900001", // sample approver staff id in the square-bracket remark shape
  "21BCE1234", // the designated fake registration number (4-digit sequence shape)
  "00000000-0000-0000-0000-000000000000", // all-zero CSRF placeholder
  // The registration-form placeholder on the landing page. It matches the
  // registration-number rule by design - it has to, or the field would not
  // show students the real shape of their own id (2-digit batch, 3-letter
  // branch, 5-digit sequence). It is here rather than inline because every
  // other string of this shape must fail the build.
  //
  // It must stay obviously synthetic. An earlier suggestion reused the
  // operator's own five-digit sequence with a different branch code, which is
  // one group away from a real identifier - that is the failure this guard
  // exists to prevent, not an acceptable placeholder.
  "23ABC12345",
]);

/**
 * Patterns for data that could identify a person. Ordered roughly by severity.
 * Each entry explains WHY it matters so a future edit doesn't "helpfully"
 * widen or narrow it without thinking.
 */
const FORBIDDEN: { name: string; re: RegExp; why: string; only?: RegExp }[] = [
  {
    name: "VIT Bhopal registration number",
    // 5-digit sequences are current Bhopal ids; 4-digit tails match legacy
    // and other-campus shapes, so both are guarded. The only values of
    // either shape that may appear are allowlisted SYNTHETIC fakes.
    re: /\b\d{2}[A-Z]{3}\d{4,5}\b/g,
    why: "the student's unique identifier - this is the single most identifying string possible",
  },
  {
    name: "VTOP leave id",
    re: /\bL\d{6,}\b/g,
    why: "a leave id is issued to one person and links to their hostel record",
  },
  {
    // Capture group 1 is the staff id itself, so the allowlist compares the
    // identifier rather than the surrounding markup. Live leave history
    // renders the square-bracket shape (by [ 900001 ] [ NAME]), so both
    // bracket styles are matched — a real id in either shape must trip.
    name: "staff id in an approver remark",
    re: /\bby\s*[[{]\s*(\d{5,8})\s*[\]}]/g,
    why: "proctor/staff identifiers are THIRD-PARTY data, not the repo owner's",
  },
  {
    name: "VTOP CSRF token value",
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    why: "a session-bound CSRF token should never be committed in any form",
  },
  {
    // Scoped to env files: the README MUST document these variable names, so
    // matching documentation would forbid the thing users need in order to
    // configure the server at all.
    name: "credential assigned in an env file",
    // Horizontal whitespace only. With \s and the m flag, a CRLF file lets the
    // pattern swallow the \r and match the NEXT line - which made an empty
    // `VTOP_PASSWORD=` look like it had the next variable as its value.
    re: /^[ \t]*(VTOP_PASSWORD|VTOP_USERNAME)[ \t]*=[ \t]*(\S+)[ \t]*$/gm,
    why: "credentials belong in .env, which is gitignored; .env.example must leave them blank",
    only: /(^|[\\/])\.env(\.example)?$/,
  },
  // NOT checked, deliberately: semester ids (BL20262701) and course codes
  // (CSD3002). Both identify a TERM or a CATALOGUE ENTRY, not a person - an
  // entire cohort shares a semester id, and VIT publishes its course list.
  // Source legitimately cites a real semester id as provenance for an inferred
  // rule, so blanking it would make the comment a lie rather than safer.
];

console.log("fixture privacy guard (offline)");

check("the repo actually has files to scan (guard cannot pass vacuously)", () => {
  assert.ok(files.length > 10, `only found ${files.length} files - is the walk broken?`);
  assert.ok(
    files.some((f) => f.endsWith("leave-test.ts")),
    "expected the leave tests to be present in the scan",
  );
});

for (const rule of FORBIDDEN) {
  check(`no ${rule.name}`, () => {
    const offenders: string[] = [];
    for (const file of files) {
      // `only` narrows a rule to particular files (relative paths, POSIX or
      // Windows separators), so documentation can still mention a name.
      if (rule.only && !rule.only.test(path.relative(ROOT, file))) continue;
      const text = fs.readFileSync(file, "utf8");
      const matches = [...text.matchAll(rule.re)];
      if (!matches.length) continue;
      const rel = path.relative(ROOT, file);
      for (const m of matches.slice(0, 3)) {
        // Prefer the capture group so the allowlist compares the identifier
        // itself; fall back to the whole match when there is no group.
        const value = m[1] ?? m[0];
        if (SYNTHETIC.has(value)) continue;
        offenders.push(`${rel}: ${JSON.stringify(value)}`);
      }
    }
    assert.equal(
      offenders.length,
      0,
      `${rule.name} found in the working tree - ${rule.why}.\n  ` +
        offenders.join("\n  ") +
        "\n  Replace with a synthetic value that keeps the same SHAPE.",
    );
  });
}

check("both approver-id bracket styles trip the staff rule", () => {
  // Guards against a future edit narrowing the character class back to
  // curly braces: live history uses square brackets.
  const rule = FORBIDDEN.find((r) => r.name === "staff id in an approver remark")!;
  for (const sample of ["by { 9000001 } [ X ]", "by [ 900001 ] [ X ]"]) {
    const m = [...sample.matchAll(rule.re)];
    assert.equal(m.length, 1, `${sample} must match`);
    assert.ok(SYNTHETIC.has(m[0][1]), `${m[0][1]} must be an allowlisted fake`);
  }
  const real = [..."REQUEST APPROVED by [ 51234 ] [ REAL NAME ]".matchAll(rule.re)];
  assert.equal(real.length, 1, "a real bracketed id must trip");
  assert.ok(!SYNTHETIC.has(real[0][1]), "a real id must not be allowlisted");
});

check("both reg-number tail lengths trip the rule", () => {
  const rule = FORBIDDEN.find((r) => r.name === "VIT Bhopal registration number")!;
  assert.ok("21BCE1234".match(rule.re), "4-digit tail must match");
  assert.ok("23ABC12345".match(rule.re), "5-digit tail must match");
  assert.ok(SYNTHETIC.has("21BCE1234") && SYNTHETIC.has("23ABC12345"), "both shapes need allowlisted fakes");
});

check(".env.example documents the variables without filling them in", () => {
  const example = path.join(ROOT, ".env.example");
  if (!fs.existsSync(example)) return; // optional file
  const text = fs.readFileSync(example, "utf8");
  // Horizontal whitespace only, for the same CRLF reason as the rule above.
  const filled = text.match(/^[ \t]*VTOP_(PASSWORD|USERNAME)[ \t]*=[ \t]*\S+[ \t]*$/gm);
  assert.equal(
    filled?.length ?? 0,
    0,
    `.env.example must leave credentials blank; found: ${filled?.join(", ")}`,
  );
});

check(".gitignore excludes .env", () => {
  const gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(gi, /^\.env$/m, ".env must be gitignored");
});

check("licence and attribution files are present for Apache-2.0 compliance", () => {
  // Apache-2.0 requires the licence text and NOTICE to be retained. Git history
  // is NOT required, which is why this repo can publish without upstream's
  // commit log.
  for (const required of ["LICENSE", "NOTICE", "LICENSE-MIT-upstream"]) {
    assert.ok(
      fs.existsSync(path.join(ROOT, required)),
      `${required} is missing - required for licence compliance`,
    );
  }
  const notice = fs.readFileSync(path.join(ROOT, "NOTICE"), "utf8");
  assert.match(notice, /Apache License/i, "NOTICE must state the licence");
  assert.match(
    notice,
    /VtopMCP|Vikranth|upstream|fork/i,
    "NOTICE must credit the upstream project this derives from",
  );
});

console.log(`\n${passed} checks passed.`);
console.log(
  "Reminder: fixtures may mirror the real SHAPE of a VTOP response but must " +
    "never carry real VALUES. Paste the structure, retype the contents.",
);