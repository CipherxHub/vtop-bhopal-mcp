#!/usr/bin/env tsx
/**
 * Live shape probe for the two tools missing from the MCP surface:
 *   1. faculty directory  (hrms/employeeSearchForStudent → EmployeeSearchForStudent → EmployeeSearch1ForStudent)
 *   2. syllabus download  (GET courseSyllabusDownload1/{CODE} → PDF bytes)
 *
 * Browser automation found the URLs and the JS call chain, but not the POST
 * field names or the response markup — those cannot be guessed, so this
 * script reads them live and dumps the raw responses for parser work.
 *
 * Manual-credentials flow (nothing is written to disk except test-output/,
 * which is gitignored and skipped by test:privacy). ONE process does captcha
 * AND login: VTOP binds each captcha image to the session that fetched it, so
 * fetching in one process and submitting from another 404s (SESSION_MISMATCH).
 *
 *   $env:VTOP_USERNAME='your-reg-no'; $env:VTOP_PASSWORD=(Read-Host 'password')
 *   npx tsx scripts/live-probe.ts run
 *
 * It saves test-output/probe-captcha.jpg, then polls for
 * test-output/probe-captcha-answer.txt (write the characters you read into
 * that file, plain text, no newline needed). You have ~2 minutes; the image
 * itself is only valid 30-60s, so answer fast. The answer file is deleted
 * after reading.
 *
 * Stdout carries SHAPES ONLY (tag names, input names, header labels, byte
 * counts) — never values. Do not paste the dump files anywhere; they carry
 * real session data and must stay local.
 */
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { VtopClient } from "../src/services/vtop-client.js";
import { ENDPOINTS } from "../src/services/constants.js";

const OUT = path.join(process.cwd(), "test-output");
const QUERY = "pal"; // common fragment; shapes, not values, are what matter
const SYLLABUS_CODE = "CSD3010"; // catalogue code, not personal data

function out(name: string, data: string | Buffer): string {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, data);
  return file;
}

/** Collapse a response to its structural skeleton for safe stdout. */
function skeleton(html: string, max = 1200): string {
  const $ = cheerio.load(html);
  const tags: string[] = [];
  $("table").each((ti, t) => {
    const headers: string[] = [];
    $(t)
      .find("th, td")
      .slice(0, 8)
      .each((_, c) => headers.push($(c).text().trim().slice(0, 40)));
    const rows = $(t).find("tr").length;
    tags.push(`table#${ti}[rows=${rows} headers=${JSON.stringify(headers)}]`);
  });
  const inputs: string[] = [];
  $("input").each((_, i) =>
    inputs.push(`${$(i).attr("name") ?? "?"}:${$(i).attr("type") ?? "?"}`),
  );
  const scripts: string[] = [];
  $("button,a").each((_, b) => {
    const oc = $(b).attr("onclick");
    if (oc) scripts.push(oc.slice(0, 120).replace(/\('[^']*'\)/g, "('<id>')"));
  });
  return [...tags, `inputs=${JSON.stringify(inputs)}`, `onclick=${JSON.stringify(scripts.slice(0, 4))}`]
    .join("\n")
    .slice(0, max);
}

async function main(): Promise<void> {
  const [, , cmd, arg] = process.argv;
  const username = process.env.VTOP_USERNAME ?? "";
  const password = process.env.VTOP_PASSWORD ?? "";
  if (!username || !password) {
    console.error("Set VTOP_USERNAME and VTOP_PASSWORD in the environment first (never in a file).");
    process.exit(2);
  }
  const client = new VtopClient();

  if (cmd !== "run") {
    console.error("usage: live-probe.ts run   (fetches a captcha, waits for the answer file, then probes)");
    process.exit(2);
  }

  // Single process end to end: the captcha MUST be submitted from the client
  // that fetched it (separate captcha/run processes 404 with SESSION_MISMATCH).
  const captchaUrl = await client.getCaptcha();
  const captchaFile = out(
    "probe-captcha.jpg",
    Buffer.from(captchaUrl.replace(/^data:image\/\w+;base64,/, ""), "base64"),
  );
  const answerFile = path.join(OUT, "probe-captcha-answer.txt");
  try {
    fs.unlinkSync(answerFile);
  } catch {
    /* no stale answer */
  }
  console.log(`OPEN ${captchaFile}, read the characters, write them into ${answerFile} (plain text). Waiting up to 120s...`);
  const deadline = Date.now() + 120_000;
  let captcha = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const text = fs.readFileSync(answerFile, "utf8").trim();
      if (text) {
        captcha = text;
        break;
      }
    } catch {
      /* not written yet */
    }
  }
  try {
    fs.unlinkSync(answerFile);
  } catch {
    /* already gone */
  }
  if (!captcha) {
    console.error("no answer arrived in time — rerun and answer faster (the image expires in 30-60s).");
    process.exit(2);
  }

  await client.login(username, password, captcha);
  console.log("login OK");

  // 1a. faculty page shell — learn the search form wiring, don't guess it.
  const pageHtml = await client.fetchPage(ENDPOINTS.facultySearchPage, {
    verifyMenu: "true",
    nocache: String(Date.now()),
  });
  out("probe-faculty-page.html", pageHtml);
  console.log("--- faculty page skeleton ---\n" + skeleton(pageHtml));

  const $p = cheerio.load(pageHtml);
  const textInputs: string[] = [];
  $p("input[type=text], input:not([type])").each((_, i) => {
    const name = $p(i).attr("name");
    if (name) textInputs.push(name);
  });
  const formAction = $p("form").first().attr("action") ?? "";
  console.log(`search form action=${formAction || "(none)"} textInputs=${JSON.stringify(textInputs)}`);

  // 1b. search posts empId=<name fragment> (NOT searchEmployee — that is only
  // the input's id; the page's getEmployeeInfo() sends empId). Letters and
  // spaces only, minimum 3 characters, mirroring the page's own validation.
  const query = QUERY;
  if (query.trim().length < 3 || /[^a-zA-Z ]/.test(query)) {
    console.log("query violates the page's own validation (min 3 chars, letters/spaces) — fix QUERY and rerun.");
    return;
  }
  const searchHtml = await client.fetchPage(ENDPOINTS.facultySearch, {
    empId: query,
    x: new Date().toUTCString(),
  });
  out("probe-faculty-search.html", searchHtml);
  console.log("--- faculty search skeleton ---\n" + skeleton(searchHtml));

  // 1c. detail: rows carry getEmployeeIdNo('<empId>') on the Action button;
  // the detail call re-sends that id as empId.
  const $s = cheerio.load(searchHtml);
  const onclicks: string[] = [];
  $s("[onclick]").each((_, el) => {
    const oc = $s(el).attr("onclick") ?? "";
    if (/getEmployeeIdNo/i.test(oc)) onclicks.push(oc);
  });
  const idMatch = (onclicks[0] ?? "").match(/['"]([A-Za-z0-9_-]{3,})['"]/);
  console.log(`detail onclick shape=${JSON.stringify((onclicks[0] ?? "(none)").slice(0, 120).replace(/['"][A-Za-z0-9_-]{3,}['"]/g, "'<id>'"))}`);
  if (idMatch) {
    const detailHtml = await client.fetchPage(ENDPOINTS.facultyDetail, {
      empId: idMatch[1],
      x: new Date().toUTCString(),
    });
    out("probe-faculty-detail.html", detailHtml);
    console.log("detail fetched — dumped");
    console.log("--- faculty detail skeleton ---\n" + skeleton(detailHtml));
  } else {
    console.log("NO detail id discovered — stopping after the search dump for analysis.");
  }

  // 2. syllabus bytes end to end.
  const { bytes, contentType } = await client.downloadBytes(
    `${ENDPOINTS.courseSyllabusDownload}/${SYLLABUS_CODE}`,
    { x: new Date().toUTCString() },
  );
  const isPdf = bytes.subarray(0, 4).toString() === "%PDF";
  console.log(`syllabus: contentType=${contentType} bytes=${bytes.length} pdfHeader=${isPdf}`);
  if (isPdf) {
    console.log(`syllabus saved: ${out("probe-syllabus.pdf", bytes)}`);
  }

  // 3. profile photo: the logged-in pages render the avatar from
  // users/image/?id=<regNo>. Confirm it answers image bytes, not HTML.
  const regNo: string = (client as unknown as { authorizedID?: string }).authorizedID ?? "";
  if (!regNo) {
    console.log("photo: no authorizedID on the client — skipping.");
    return;
  }
  try {
    const photo = await client.downloadBytes("users/image/", {
      id: regNo,
      x: new Date().toUTCString(),
    });
    const head = photo.bytes.subarray(0, 4);
    const isJpeg = head[0] === 0xff && head[1] === 0xd8;
    const isPng = head[0] === 0x89 && head[1] === 0x50;
    console.log(`photo: contentType=${photo.contentType} bytes=${photo.bytes.length} jpeg=${isJpeg} png=${isPng}`);
    if (isJpeg || isPng) {
      console.log(`photo saved: ${out("probe-photo.jpg", Buffer.from(photo.bytes))}`);
    }
  } catch (err) {
    console.log(`photo: threw ${(err as Error).message.slice(0, 160)}`);
  }
}

main().catch((err) => {
  console.error("probe failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
