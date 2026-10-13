#!/usr/bin/env tsx
/**
 * Calendar diagnostic. Logs in once with a captcha you supply, then dumps the
 * raw HTML of every stage of the academic-calendar handshake so we can see
 * exactly where the day rows stop appearing.
 *
 *   npx tsx scripts/calendar-debug.ts <CAPTCHA>
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { VtopClient } from "../src/services/vtop-client.js";
import { ENDPOINTS } from "../src/services/constants.js";

const captcha = process.argv[2];
if (!captcha) {
  console.error("usage: calendar-debug.ts <CAPTCHA>");
  process.exit(2);
}

const OUT = path.join(process.cwd(), "tmp-caldebug");
fs.mkdirSync(OUT, { recursive: true });

const dump = (name: string, html: string) => {
  const f = path.join(OUT, `${name}.html`);
  fs.writeFileSync(f, html, "utf8");
  // Cheap shape summary so we can see the problem without opening the file.
  const rows = (html.match(/<tr/gi) || []).length;
  const holiday = /holiday|no\s*class/i.test(html);
  console.log(
    `  ${name.padEnd(24)} len=${String(html.length).padEnd(8)} <tr>=${String(rows).padEnd(5)} holidayish=${holiday}`,
  );
  return f;
};

const client = new VtopClient();
const today = new Date().toISOString().slice(0, 10);

// Take the captcha ourselves and write it out, so it can be read and answered
// within its short expiry. The answer is polled from a sidecar file.
//
// VTOP's captcha expires in well under a minute, and a human-in-the-loop
// (or model-in-the-loop) answer reliably takes longer than that, so a single
// shot here fails far more often than it succeeds. Retry: each round fetches a
// fresh captcha, writes captcha-<n>.jpg, and waits for answer-<n>.txt. That
// makes the script's success depend on getting ONE attempt through, not on
// beating the clock on the first try.
const ANSWER_DIR = OUT;
if (captcha !== "--") {
  console.error("run with -- to fetch a captcha and poll for the answer");
  process.exit(2);
}

const MAX_ROUNDS = Number(process.env.CALDEBUG_ROUNDS ?? 8);
const WAIT_MS = Number(process.env.CALDEBUG_WAIT_MS ?? 75_000);
let loggedIn = false;

for (let round = 1; round <= MAX_ROUNDS && !loggedIn; round++) {
  const answerPath = path.join(ANSWER_DIR, `answer-${round}.txt`);
  const imgPath = path.join(OUT, `captcha-${round}.jpg`);
  try { fs.unlinkSync(answerPath); } catch { /* first round */ }

  let dataUri: string;
  try {
    dataUri = await client.getCaptcha();
  } catch (err) {
    console.error(`round ${round}: captcha fetch failed: ${err}`);
    await new Promise((r) => setTimeout(r, 5000));
    continue;
  }
  const b64 = dataUri.replace(/^data:image\/\w+;base64,/, "");
  fs.writeFileSync(imgPath, Buffer.from(b64, "base64"));
  console.log(`ROUND ${round}: CAPTCHA IMAGE: ${imgPath}`);

  let answer = "";
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (fs.existsSync(answerPath)) {
      answer = fs.readFileSync(answerPath, "utf8").trim();
      if (answer) break;
    }
  }
  if (!answer) {
    console.error(`round ${round}: no answer appeared`);
    continue;
  }

  console.log(`round ${round}: login with answer=${answer}`);
  try {
    const res = await client.login(
      process.env.VTOP_USERNAME!,
      process.env.VTOP_PASSWORD!,
      answer,
    );
    loggedIn = res.success;
    if (!loggedIn) console.error(`round ${round}: login rejected`);
  } catch (err) {
    console.error(
      `round ${round}: login threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

if (!loggedIn) {
  console.error("could not log in within the round budget");
  process.exit(1);
}
console.log("  logged in");

console.log("[3] semesters");
const sems = await client.getSemesters();
console.log(`  ${JSON.stringify(sems).slice(0, 300)}`);

// The current semester id used by the MCP tools.
const semId = (sems as any[])?.[0]?.id ?? (sems as any[])?.[0]?.semesterId ?? "";
console.log(`  using semesterId=${semId}`);

console.log("[4] calendarPreview");
const prev = await client.fetchPage(ENDPOINTS.calendarPreview, {});
dump("01-calendarPreview", prev);

console.log("[5] calendarMonthList");
const listHtml = await client.fetchPage(ENDPOINTS.calendarMonthList, {
  paramReturnId: "getListForSemester",
  semSubId: semId,
  classGroupId: "COMB",
  x: new Date().toUTCString(),
});
dump("02-calendarMonthList", listHtml);

// Pull out whatever looks like a month identifier, so we can see the real
// shape rather than assuming a format.
const calDates = [...listHtml.matchAll(/calDate["'=:\s]+([A-Za-z0-9_-]+)/g)].map(
  (m) => m[1],
);
console.log(`  calDate candidates: ${JSON.stringify([...new Set(calDates)].slice(0, 20))}`);

console.log("[6] calendarMonth (first candidate)");
const firstCalDate = [...new Set(calDates)][0];
if (!firstCalDate) {
  console.error("  NO calDate FOUND — the month list did not parse.");
} else {
  const monthHtml = await client.fetchPage(ENDPOINTS.calendarMonth, {
    calDate: firstCalDate,
    semSubId: semId,
    classGroupId: "COMB",
    x: new Date().toUTCString(),
  });
  dump(`03-calendarMonth-${firstCalDate}`, monthHtml);
}

console.log("[7] getCalendar (the real call)");
try {
  const cal = await client.getCalendar(semId, today, "2026-10-30");
  console.log(`  returned ${cal.length} days total (whole months, not the window)`);
  console.log("  ALL days, in order:");
  for (const d of cal as any[]) {
    const mark = d.instructional ? "INSTR " : "       ";
    console.log(`    ${d.date}  ${mark} ${d.label || ""}`);
  }
  const inWindow = (cal as any[]).filter(
    (d) => d.date >= today && d.date <= "2026-10-30",
  );
  console.log(
    `\n  window ${today}..2026-10-30: ${inWindow.length} days, ` +
      `${inWindow.filter((d) => d.instructional).length} instructional`,
  );
  const afterToday = (cal as any[]).filter((d) => d.date >= today);
  console.log(
    `  days from today onwards: ${afterToday.length}, ` +
      `instructional ${afterToday.filter((d) => d.instructional).length}`,
  );
  const lastInstr = (cal as any[])
    .filter((d) => d.instructional)
    .map((d) => d.date)
    .sort()
    .at(-1);
  console.log(`  LAST INSTRUCTIONAL DAY: ${lastInstr}`);
} catch (e) {
  console.error(`  getCalendar threw: ${e instanceof Error ? e.message : String(e)}`);
}

console.log(`\nDumps in ${OUT}`);