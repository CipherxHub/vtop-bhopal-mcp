#!/usr/bin/env tsx
/**
 * End-to-end test of the PUBLISHED npm package.
 *
 * Spawns `npx -y @vikranth2005/vtop-mcp` (downloading it from the public
 * registry, exactly like a user's Claude Desktop would) and speaks MCP
 * JSON-RPC over stdio to verify:
 *   1. initialize handshake → serverInfo.name + version
 *   2. tools/list → 17 expected tools, all with input schemas
 *   3. (network-permitting) tools/call get_captcha → image content
 *
 * Steps 1–2 prove the published artifact runs and exposes the right
 * surface without needing VIT network. Step 3 is WARN-only.
 */
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";

const PKG = process.env.TEST_PKG ?? "@vikranth2005/vtop-mcp";
const REGISTRY = "https://registry.npmjs.org";

const EXPECTED_TOOLS = [
  "get_captcha",
  "login",
  "logout",
  "get_semesters",
  "get_profile",
  "get_attendance",
  "get_timetable",
  "get_marks",
  "get_exam_schedule",
  "get_semester_grades",
  "get_grade_history",
  "get_curriculum_progress",
  "calculate_attendance",
  "get_today_classes",
  "get_calendar",
  "calculate_gpa",
  "calculate_od",
].sort();

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
};

class McpStdioClient {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, (r: JsonRpcResponse) => void>();
  private buf = "";

  constructor() {
    const isLocal = PKG.endsWith(".tgz") || PKG.includes("/") || PKG.includes("\\");
    const regFlag = isLocal ? "" : `--registry=${REGISTRY} `;
    const cmd = `npx -y ${regFlag}${PKG}`;
    const posixArgs = isLocal
      ? ["-y", PKG]
      : ["-y", `--registry=${REGISTRY}`, PKG];
    this.proc = (
      process.platform === "win32"
        ? spawn("cmd", ["/c", cmd], { stdio: ["pipe", "pipe", "pipe"], env: process.env })
        : spawn("npx", posixArgs, {
            stdio: ["pipe", "pipe", "pipe"],
            env: process.env,
          })
    ) as ChildProcessWithoutNullStreams;
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (c: string) => this.onStdout(c));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (c: string) =>
      process.stderr.write(`[server] ${c}`)
    );
    this.proc.on("exit", (code) => {
      for (const r of this.pending.values())
        r({ jsonrpc: "2.0", id: -1, error: { code: -1, message: `exited ${code}` } });
      this.pending.clear();
    });
  }

  private onStdout(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg: JsonRpcResponse = JSON.parse(line);
        if (typeof msg.id === "number") {
          const r = this.pending.get(msg.id);
          if (r) {
            this.pending.delete(msg.id);
            r(msg);
          }
        }
      } catch {
        process.stderr.write(`[smoke] non-JSON: ${line}\n`);
      }
    }
  }

  request(method: string, params?: unknown, timeoutMs = 120_000): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(t);
        resolve(r);
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string, params?: unknown) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

async function main() {
  console.error(`[smoke] spawning: npx -y --registry=${REGISTRY} ${PKG}`);
  console.error("[smoke] (first run downloads the package — may take ~20s)\n");
  const client = new McpStdioClient();
  const results: { step: string; status: "PASS" | "WARN" | "FAIL"; note?: string }[] = [];
  let hardFail = false;

  try {
    const res = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "published-smoke", version: "0.0.0" },
    });
    if (res.error) throw new Error(res.error.message);
    const info = (res.result as { serverInfo?: { name?: string; version?: string } })
      ?.serverInfo;
    if (info?.name !== "vtop-mcp")
      throw new Error(`serverInfo.name='${info?.name}'`);
    results.push({
      step: "initialize",
      status: "PASS",
      note: `name=${info.name} version=${info.version}`,
    });
    client.notify("notifications/initialized");
  } catch (e) {
    hardFail = true;
    results.push({ step: "initialize", status: "FAIL", note: String(e) });
  }

  if (!hardFail) {
    try {
      const res = await client.request("tools/list", {});
      if (res.error) throw new Error(res.error.message);
      const names = ((res.result as { tools?: { name: string; inputSchema?: unknown }[] }).tools ?? [])
        .map((t) => t.name)
        .sort();
      const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
      const extra = names.filter((t) => !EXPECTED_TOOLS.includes(t));
      if (missing.length || extra.length)
        throw new Error(`missing=[${missing}] extra=[${extra}]`);
      results.push({
        step: "tools/list",
        status: "PASS",
        note: `${names.length} tools`,
      });
    } catch (e) {
      hardFail = true;
      results.push({ step: "tools/list", status: "FAIL", note: String(e) });
    }
  }

  if (!hardFail) {
    try {
      const res = await client.request("tools/call", {
        name: "get_captcha",
        arguments: {},
      });
      if (res.error) throw new Error(res.error.message);
      const r = res.result as { content?: { type: string }[]; isError?: boolean };
      if (r.isError) throw new Error("tool isError=true");
      if (!(r.content ?? []).some((c) => c.type === "image"))
        throw new Error("no image content");
      results.push({ step: "tools/call get_captcha", status: "PASS" });
    } catch (e) {
      results.push({
        step: "tools/call get_captcha",
        status: "WARN",
        note: `network-dependent: ${e}`,
      });
    }
  }

  client.close();

  console.error("\n[smoke] results:");
  for (const r of results)
    console.error(`  ${r.status.padEnd(4)}  ${r.step}${r.note ? "  — " + r.note : ""}`);
  const failed = results.some((r) => r.status === "FAIL");
  console.error(failed ? "\n[smoke] FAIL" : "\n[smoke] OK — published package works");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("[smoke] fatal:", e);
  process.exit(2);
});
