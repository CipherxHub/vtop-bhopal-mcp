#!/usr/bin/env tsx
/**
 * VtopMCP local end-to-end test harness.
 *
 * Runs through the full tool surface against the real VTOP portal using a
 * single shared VtopClient. Imports VtopClient + parsers directly (bypasses
 * the MCP stdio layer) so failures attribute cleanly to client/parser bugs.
 *
 * Requires: a `.env` with VTOP_USERNAME + VTOP_PASSWORD, and a VIT-reachable
 * network. Captcha is solved interactively.
 *
 * Set VTOP_DUMP_HTML=1 to also capture raw HTML responses for fixture seeding.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

import { VtopClient } from "../src/services/vtop-client.js";
import {
  parseAttendance,
  parseTimetable,
  parseMarks,
  parseExamSchedule,
  parseGradeHistory,
  parseSemesterGrades,
  parseProfile,
} from "../src/services/vtop-parser.js";

type Status = "PASS" | "WARN" | "FAIL";
type Result = {
  tool: string;
  status: Status;
  durationMs: number;
  bytes: number;
  rows: number | string;
  note?: string;
};

// One readline for every prompt. A second raw-mode stdin reader (the old
// promptPassword) raced this one: readline still echoed the password, then the
// raw reader paused stdin and later prompts hung. Mute readline's echo instead.
let muted = false;
const rlOut = new Writable({
  write(chunk, encoding, cb) {
    if (!muted) stdout.write(chunk, encoding);
    cb();
  },
});
const rl = readline.createInterface({ input: stdin, output: rlOut, terminal: true });

async function prompt(q: string): Promise<string> {
  return (await rl.question(q)).trim();
}

async function promptPassword(q: string): Promise<string> {
  stdout.write(q);
  muted = true;
  try {
    return (await rl.question("")).trim();
  } finally {
    muted = false;
    stdout.write("\n");
  }
}

function openInDefaultViewer(file: string): void {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", file], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [file], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [file], { detached: true, stdio: "ignore" }).unref();
  }
}

async function saveCaptcha(dataUrl: string, dir: string): Promise<string> {
  const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!match) throw new Error("Captcha is not a data URL");
  const [, ext, b64] = match;
  const file = path.join(dir, `captcha.${ext}`);
  await writeFile(file, Buffer.from(b64, "base64"));
  return file;
}

async function captureCaptchaAndLogin(
  client: VtopClient,
  username: string,
  password: string,
  outDir: string
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.error(`\n[auth] attempt ${attempt}/3: fetching captcha...`);
    const dataUrl = await client.getCaptcha();
    const file = await saveCaptcha(dataUrl, outDir);
    console.error(`[auth] captcha saved to ${file} (opening in default viewer)`);
    openInDefaultViewer(file);
    const captcha = await prompt("captcha text: ");

    console.error("[auth] logging in...");
    const res = await client.login(username, password, captcha);
    if (res.success) {
      console.error("[auth] login OK");
      return;
    }
    console.error(`[auth] failed: ${res.message}`);
    if (!/captcha/i.test(res.message)) {
      throw new Error(`Login failed: ${res.message}`);
    }
  }
  throw new Error("Login failed after 3 captcha attempts");
}

type Step = {
  name: string;
  run: () => Promise<{ rows: number | string; bytes: number; data: unknown; warnIfEmpty?: boolean }>;
  passCheck?: (data: unknown) => boolean;
};

function makeSteps(client: VtopClient, semesterId: string): Step[] {
  const semPayload: Record<string, string> = semesterId ? { semesterSubId: semesterId } : {};
  return [
    {
      name: "get_profile",
      run: async () => {
        const html = await client.fetchPage("studentsRecord/StudentProfileAllView", {
          verifyMenu: "true",
          nocache: String(Date.now()),
        });
        const data = parseProfile(html);
        return { rows: 1, bytes: html.length, data };
      },
      passCheck: (d: any) => !!d?.name && !!d?.registrationNumber,
    },
    {
      name: "get_attendance",
      run: async () => {
        const html = await client.fetchPage("processViewStudentAttendance", semPayload);
        const data = parseAttendance(html);
        return { rows: data.length, bytes: html.length, data };
      },
      passCheck: (d: any) =>
        Array.isArray(d) &&
        d.length > 0 &&
        typeof d[0].courseCode === "string" &&
        Number.isFinite(d[0].percentage),
    },
    {
      name: "get_timetable",
      run: async () => {
        const html = await client.fetchPage("processViewTimeTable", semPayload);
        const data = parseTimetable(html);
        return { rows: data.length, bytes: html.length, data };
      },
      passCheck: (d: any) =>
        Array.isArray(d) && d.length > 0 && typeof d[0].courseCode === "string",
    },
    {
      name: "get_marks",
      run: async () => {
        const html = await client.fetchPage("examinations/doStudentMarkView", semPayload);
        const data = parseMarks(html);
        return { rows: data.length, bytes: html.length, data, warnIfEmpty: true };
      },
      passCheck: (d: any) => Array.isArray(d) && d.length > 0,
    },
    {
      name: "get_exam_schedule",
      run: async () => {
        const html = await client.fetchPage(
          "examinations/doSearchExamScheduleForStudent",
          semPayload
        );
        const data = parseExamSchedule(html);
        return { rows: data.length, bytes: html.length, data, warnIfEmpty: true };
      },
      passCheck: (d: any) => Array.isArray(d) && d.length > 0,
    },
    {
      name: "get_semester_grades",
      run: async () => {
        const html = await client.fetchPage(
          "examinations/examGradeView/doStudentGradeView",
          semPayload
        );
        const data = parseSemesterGrades(html);
        return {
          rows: data.grades?.length ?? 0,
          bytes: html.length,
          data,
          warnIfEmpty: true,
        };
      },
      passCheck: (d: any) => Array.isArray(d?.grades) && d.grades.length > 0,
    },
    {
      name: "get_grade_history",
      run: async () => {
        const html = await client.fetchPage("examinations/examGradeView/StudentGradeHistory", {
          verifyMenu: "true",
          nocache: String(Date.now()),
        });
        const data = parseGradeHistory(html);
        return {
          rows: data.semesters?.length ?? 0,
          bytes: html.length,
          data,
        };
      },
      passCheck: (d: any) =>
        Number.isFinite(d?.cgpa) && Array.isArray(d?.semesters) && d.semesters.length > 0,
    },
  ];
}

function fmtRow(r: Result): string {
  const status = r.status.padEnd(4);
  const dur = `${r.durationMs}ms`.padStart(7);
  const bytes = `${r.bytes}b`.padStart(8);
  const rows = String(r.rows).padStart(4);
  const note = r.note ? `  ${r.note}` : "";
  return `  ${status}  ${r.tool.padEnd(22)} ${dur}  ${bytes}  rows=${rows}${note}`;
}

// Menu paths differ per campus (Chennai's StudentTimeTableChn is "not available"
// on Bhopal). VTOP_MENU_DUMP=1: read the real menu off the home page and dump
// every academic page it links to, so endpoints can be matched per campus.
// Fee/payment pages are never fetched.
const MENU_WANT = /academics|examinations|studentsRecord|attendance|timetable|calendar|grade|mark|curriculum/i;
const MENU_SKIP = /fee|pay|financ|wallet|bank|receipt|hostel|transport|logout|password|Reg$|StudentReg|Request|withdraw|QCM/i;

async function dumpMenu(client: VtopClient, outDir: string): Promise<void> {
  process.env.VTOP_DUMP_DIR = outDir;
  process.env.VTOP_DUMP_HTML = "1";
  // ponytail: reaches into the private axios client; fine for a dev harness.
  const home: string = (await (client as any).dataClient().get("/content")).data;
  await writeFile(path.join(outDir, "_home.html"), home);

  const links = new Map<string, string>();
  // Bhopal builds the menu in JS, so the paths only appear as quoted strings.
  const re = /['"]((?:academics|examinations|studentsRecord)\/[\w/]+)['"]/g;
  for (const m of home.matchAll(re)) if (!links.has(m[1])) links.set(m[1], "");
  console.error(`\n[menu] ${links.size} menu links on the home page (full list in menu.json)`);

  const summary: { url: string; label: string; status: string; bytes: number; options: number }[] = [];
  for (const [url, label] of links) {
    if (!MENU_WANT.test(url + " " + label) || MENU_SKIP.test(url + " " + label)) {
      summary.push({ url, label, status: "skipped", bytes: 0, options: 0 });
      continue;
    }
    try {
      const html = await client.fetchPage(url, { verifyMenu: "true", nocache: String(Date.now()) });
      const status = /not available at present/i.test(html) ? "not-available" : "ok";
      const options = (html.match(/<option\s/gi) ?? []).length;
      summary.push({ url, label, status, bytes: html.length, options });
      console.error(`  ${status.padEnd(13)} ${url}  "${label}"  ${html.length}b  options=${options}`);
    } catch (err) {
      summary.push({ url, label, status: `error: ${String(err).slice(0, 80)}`, bytes: 0, options: 0 });
      console.error(`  error         ${url}  "${label}"`);
    }
  }
  await writeFile(path.join(outDir, "menu.json"), JSON.stringify(summary, null, 2));
  console.error(`[menu] done. Saved to ${outDir}`);
}

// VTOP_MCP_TOOLS=1: call every registered tool through the real MCP server
// (in-memory transport, sharing this logged-in client), the path Claude Code
// uses. Covers the tools the parser-level checks above don't (calendar, today,
// bunk/OD calculators, curriculum). Results go to <outDir>/mcp_<tool>.json.
async function runMcpTools(vtop: VtopClient, outDir: string): Promise<void> {
  const { server } = createServer(undefined, vtop);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const mcp = new Client({ name: "e2e", version: "0.0.0" });
  await mcp.connect(clientT);

  type Res = { content: { type: string; text?: string }[]; isError?: boolean };
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await mcp.callTool({ name, arguments: args })) as Res;
  const skip = new Set(["get_captcha", "login", "logout"]);
  const runs: [string, Record<string, unknown>][] = (await mcp.listTools()).tools
    .filter((t) => !skip.has(t.name))
    .map((t) => [t.name, {}]);
  runs.push(
    ["get_today_classes", { date: "2026-10-05" }],
    ["get_today_classes", { date: "2026-10-10" }], // Bhopal working Saturday (Friday order)
    ["calculate_attendance", { untilDate: "2026-10-12" }],
    ["get_calendar", { holidaysOnly: true }],
  );
  const sems = await vtop.getSemesters();
  if (sems[1]) runs.push(["get_semester_grades", { semesterId: sems[1].id }]);

  const lines: string[] = [];
  for (const [name, args] of runs) {
    const t0 = Date.now();
    let status = "PASS";
    let preview = "";
    try {
      const res = await call(name, args);
      const text = res.content.map((p) => p.text ?? "").join("\n");
      const label = Object.keys(args).length ? `${name}_${JSON.stringify(args)}` : name;
      await writeFile(path.join(outDir, `mcp_${label.replace(/[^\w-]+/g, "_")}.json`), text);
      if (res.isError) status = "ERROR";
      else if (!text.trim() || /^\s*(\[\s*\]|\{\s*\})\s*$/.test(text)) status = "EMPTY";
      preview = text.replace(/\s+/g, " ").slice(0, 110);
    } catch (err) {
      status = "THROW";
      preview = String(err).slice(0, 110);
    }
    const line = `  ${status.padEnd(5)} ${name.padEnd(22)} ${String(Date.now() - t0).padStart(5)}ms ${JSON.stringify(args)}  ${preview}`;
    lines.push(line);
    console.error(line);
  }
  await writeFile(path.join(outDir, "mcp_summary.txt"), lines.join("\n") + "\n");
  await mcp.close();
}

async function main() {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(process.cwd(), "test-output", runId);
  await mkdir(outDir, { recursive: true });
  console.error(`[harness] run-id: ${runId}`);
  console.error(`[harness] output: ${outDir}`);

  if (process.env.VTOP_DUMP_HTML) {
    process.env.VTOP_DUMP_DIR = outDir;
    console.error("[harness] VTOP_DUMP_HTML=1 — raw HTML will be captured");
  }

  const username = process.env.VTOP_USERNAME || (await prompt("VTOP username: "));
  const password = process.env.VTOP_PASSWORD || (await promptPassword("VTOP password: "));
  if (!username || !password) throw new Error("Missing credentials");

  const client = new VtopClient();
  await captureCaptchaAndLogin(client, username, password, outDir);

  if (process.env.VTOP_MCP_TOOLS) {
    await runMcpTools(client, outDir);
    rl.close();
    return;
  }

  if (process.env.VTOP_MENU_DUMP) {
    await dumpMenu(client, outDir);
    rl.close();
    return;
  }

  console.error("\n[harness] fetching semesters...");
  const semesters = await client.getSemesters();
  await writeFile(path.join(outDir, "semesters.json"), JSON.stringify(semesters, null, 2));
  console.error(`[harness] ${semesters.length} semesters found`);

  let semesterId = process.env.VTOP_SEMESTER_ID || "";
  if (!semesterId) {
    semesters.slice(0, 15).forEach((s, i) => {
      console.error(`  [${i}] ${s.name}  (id=${s.id})`);
    });
    const idx = await prompt("pick semester index (default 0): ");
    const picked = semesters[Number(idx) || 0];
    if (!picked) throw new Error("Invalid semester index");
    semesterId = picked.id;
  }
  console.error(`[harness] using semesterId=${semesterId}\n`);

  const results: Result[] = [];
  const steps = makeSteps(client, semesterId);

  for (const step of steps) {
    const t0 = Date.now();
    let status: Status = "PASS";
    let rows: number | string = 0;
    let bytes = 0;
    let note: string | undefined;
    try {
      const out = await step.run();
      rows = out.rows;
      bytes = out.bytes;
      await writeFile(
        path.join(outDir, `${step.name}.json`),
        JSON.stringify(out.data, null, 2)
      );
      const empty =
        (Array.isArray(out.data) && out.data.length === 0) || out.rows === 0;
      const passed = step.passCheck ? step.passCheck(out.data) : !empty;
      if (passed) {
        status = "PASS";
      } else if (empty && out.warnIfEmpty) {
        status = "WARN";
        note = "empty result (may be legit — check JSON)";
      } else {
        status = "FAIL";
        note = "shape mismatch or empty when data expected";
      }
    } catch (err: unknown) {
      status = "FAIL";
      const msg = err instanceof Error ? err.message : String(err);
      note = `exception: ${msg}`;
      await writeFile(
        path.join(outDir, `${step.name}.error.txt`),
        err instanceof Error ? (err.stack ?? err.message) : String(err)
      );
    }
    const durationMs = Date.now() - t0;
    const r: Result = { tool: step.name, status, durationMs, bytes, rows, note };
    results.push(r);
    console.error(fmtRow(r));
  }

  // logout
  const t0 = Date.now();
  let logoutStatus: Status = "PASS";
  let logoutNote: string | undefined;
  try {
    await client.logout();
  } catch (err: unknown) {
    logoutStatus = "FAIL";
    logoutNote = err instanceof Error ? err.message : String(err);
  }
  const logoutR: Result = {
    tool: "logout",
    status: logoutStatus,
    durationMs: Date.now() - t0,
    bytes: 0,
    rows: "-",
    note: logoutNote,
  };
  results.push(logoutR);
  console.error(fmtRow(logoutR));

  // summary
  console.error("\n[harness] summary:");
  const counts = results.reduce(
    (a, r) => {
      a[r.status]++;
      return a;
    },
    { PASS: 0, WARN: 0, FAIL: 0 } as Record<Status, number>
  );
  console.error(
    `  ${counts.PASS} PASS, ${counts.WARN} WARN, ${counts.FAIL} FAIL  (${results.length} total)`
  );
  console.error(`  artifacts: ${outDir}`);

  await writeFile(
    path.join(outDir, "summary.json"),
    JSON.stringify({ runId, semesterId, results, counts }, null, 2)
  );

  rl.close();
  process.exit(counts.FAIL > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\n[harness] fatal:", err instanceof Error ? err.message : err);
  rl.close();
  process.exit(2);
});
