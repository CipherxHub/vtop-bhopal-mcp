#!/usr/bin/env tsx
/**
 * Endpoint probe for the hostel leave feature.
 *
 * The leave pages are reached from the "Hostels" menu, but nothing in this repo
 * records their backend paths. Rather than guess, log in once and try a list of
 * plausible VTOP endpoints, reporting which ones return real leave content.
 *
 *   npx tsx scripts/leave-probe.ts --
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { VtopClient } from "../src/services/vtop-client.js";

const OUT = path.join(process.cwd(), "tmp-leaveprobe");
fs.mkdirSync(OUT, { recursive: true });

const client = new VtopClient();
const today = new Date().toISOString().slice(0, 10);

/**
 * Candidate paths, grouped so a hit is meaningful. VTOP uses a few common
 * families: hostel/hostels, and action-ish tails (StudentLeaveRequest,
 * LeaveApplication, doStudentLeave...).
 */
const CANDIDATES = [
  // Confirmed to exist on the shared VTOP platform (documented by the VIT-AP
  // client, whose other paths — processViewTimeTable, StudentProfileAllView —
  // are byte-identical to ours, so the platform routes carry across campuses).
  "hostel/StudentGeneralOuting",
  "hostel/StudentWeekendOuting",

  // Bhopal's own form is a richer "Leave Request" (Leave Type, Visit Place,
  // From/To date+time, Reason) rather than the generic outing form, so try the
  // plausible names for that shape too.
  "hostel/StudentLeaveApply",
  "hostel/ApplyStudentLeave",
  "hostel/StudentLeaveView",
  "hostel/LeaveForm",
  "hostel/HostelLeaveForm",
  "hostel/StudentLeaveFormView",
  "hostel/StudentLeaveApplyForm",
  "hostel/LeaveApplicationForm",
  "hostel/StudentOuting",
  "hostel/StudentOutingForm",
  "hostel/OutingRequest",
  "hostel/StudentOutingRequest",

  // history / status / pass
  "hostel/StudentLeaveHistoryDetails",
  "hostel/LeaveHistory",
  "hostel/StudentLeaveStatusView",
  "hostel/downloadLeavePass",
  "hostel/StudentLeaveApplicationStatus",

  // biometric, to confirm the hostel/* family responds at all on this campus
  "academics/biometriclogdisplay",
  "getStudBioHistory",
  "hostel/StudentLeaveRequestNew",
  "hostel/StudentLeaveFormNew",
];

const ANSWER_DIR = OUT;
const MAX_ROUNDS = Number(process.env.PROBE_ROUNDS ?? 8);
const WAIT_MS = Number(process.env.PROBE_WAIT_MS ?? 75_000);
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
  fs.writeFileSync(
    imgPath,
    Buffer.from(dataUri.replace(/^data:image\/\w+;base64,/, ""), "base64"),
  );
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
  } catch (err) {
    console.error(`round ${round}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
if (!loggedIn) {
  console.error("could not log in");
  process.exit(1);
}
console.log("  logged in\n");

// Phase 1 (high signal, one request): the sidebar/menu is shared across VTOP
// pages, so a page we already know works may already contain the hostel menu
// links. That beats guessing endpoint names blind.
console.log("[1] scanning a known-good page for leave/hostel links");
let seedHtml = "";
try {
  seedHtml = await client.getProfileHtml();
} catch (err) {
  console.log(`  profile fetch failed: ${err}`);
}
if (seedHtml) {
  const linkish = [
    ...seedHtml.matchAll(/(?:href|url|action|onclick)\s*=\s*["']([^"']+)["']/gi),
  ].map((m) => m[1]);
  const interesting = [
    ...new Set(
      linkish.filter((h) => /leave|hostel|biometric|room\s*allot/i.test(h)),
    ),
  ];
  console.log(`  ${seedHtml.length} bytes, ${linkish.length} links`);
  console.log(`  leave/hostel links: ${JSON.stringify(interesting, null, 2)}`);
  // Also any occurrence of the word, with context, in case links are built by JS.
  const ctx = [...seedHtml.matchAll(/.{70}leave.{70}/gi)].slice(0, 12).map((m) => m[0]);
  for (const c of ctx) console.log(`  ctx: ${c.replace(/\s+/g, " ")}`);
  fs.writeFileSync(path.join(OUT, "seed-profile.html"), seedHtml, "utf8");
}

// Phase 2 (fallback): try plausible endpoint names.
console.log("\n[2] probing candidate endpoints");
const hits: { endpoint: string; score: number; file: string }[] = [];
for (const ep of CANDIDATES) {
  let html = "";
  // VTOP gates module pages on nav state: the known-good platform path is
  // POSTed with verifyMenu=true plus a nocache nonce. Sending it costs nothing
  // and is required for these pages to render rather than 404.
  try {
    html = await client.fetchPage(ep, {
      verifyMenu: "true",
      nocache: String(Date.now()),
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.log(
      /ENDPOINT_NOT_FOUND/.test(m)
        ? `  ${ep.padEnd(42)} 404`
        : `  ${ep.padEnd(42)} ERROR ${m}`,
    );
    continue;
  }
  const hasLeave = /leave/i.test(html);
  const hasForm = /visit\s*place|leavetype|leave\s*type|proctor|outing/i.test(html);
  const score = (hasLeave ? 1 : 0) + (hasForm ? 1 : 0);
  const flag = score >= 2 ? "** HIT **" : hasLeave || hasForm ? "partial" : "-";
  console.log(`  ${ep.padEnd(42)} len=${String(html.length).padEnd(8)} ${flag}`);
  // Dump EVERY response. A uniform byte-length across unrelated endpoints means
  // one stub/error page rather than N real ones, and the only way to tell is to
  // read it. One login then yields the whole picture.
  {
    const safe = ep.replace(/[^\w.-]/g, "_");
    const f = path.join(OUT, `resp-${safe}.html`);
    fs.writeFileSync(f, html, "utf8");
    if (!hasLeave && !hasForm) {
      console.log(`      body: ${html.replace(/\s+/g, " ").slice(0, 400)}`);
    }
  }
  if (hasLeave || hasForm) {
    const safe = ep.replace(/[^\w.-]/g, "_");
    const f = path.join(OUT, `${safe}.html`);
    fs.writeFileSync(f, html, "utf8");
    hits.push({ endpoint: ep, score, file: f });
  }
}

console.log(`\nHITS (${hits.length}):`);
for (const h of hits) {
  console.log(`  ${h.endpoint}  score=${h.score}`);
  const html = fs.readFileSync(h.file, "utf8");
  // Surface the form fields and any endpoints referenced, which is what we
  // actually need in order to build the request.
  const ids = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/gi)].map(
    (m) => m[1],
  );
  if (ids.length) console.log(`      field ids: ${[...new Set(ids)].join(", ")}`);
  const names = [...html.matchAll(/name="([^"]+)"/gi)].map((m) => m[1]);
  if (names.length) console.log(`      name attrs: ${[...new Set(names)].slice(0, 40).join(", ")}`);
  const acts = [...html.matchAll(/(?:action|url|href)\s*[:=]\s*["']([^"']*[Ll]eave[^"']*)["']/g)].map(
    (m) => m[1],
  );
  if (acts.length) console.log(`      leave refs: ${[...new Set(acts)].join(", ")}`);
}

console.log(`\nDumps in ${OUT}`);
void today;