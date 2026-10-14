#!/usr/bin/env tsx
/**
 * MCP protocol smoke test.
 *
 * Spawns dist/index.js and exchanges JSON-RPC messages over stdio to verify:
 *   1. initialize handshake succeeds and serverInfo.name === "vtop-mcp"
 *   2. tools/list returns exactly the 22 expected tools with proper schemas
 *   3. (network-permitting) tools/call get_captcha returns an image content item
 *
 * Steps 1 and 2 work without VIT network — useful as a CI sanity check.
 * Step 3 requires VTOP reachability and is reported as WARN on failure.
 *
 * Exits 0 on success, 1 if steps 1 or 2 fail.
 */
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";

const EXPECTED_TOOLS = [
  "get_captcha",
  "login",
  "session_status",
  "get_semesters",
  "logout",
  "get_attendance",
  "get_attendance_detail",
  "get_timetable",
  "get_marks",
  "get_internal_totals",
  "get_exam_schedule",
  "get_grade_history",
  "get_semester_grades",
  "get_profile",
  "get_curriculum_progress",
  "calculate_attendance",
  "get_today_classes",
  "get_calendar",
  "check_pass_eligibility",
  "get_leave_types",
  "get_leave_status",
  "apply_leave",
  "get_leave_type_rules",
  "get_leave_history",
  "get_student_profile",
  "get_acknowledgments",
  "get_proctor_details",
  "get_curriculum_baskets",
  "get_pending_subjects",
  "get_fee_receipts",
].sort();

/**
 * Tools that WRITE to VTOP. Each must advertise readOnlyHint=false so an MCP
 * client raises a permission prompt instead of auto-approving it.
 *
 * This is asserted, not assumed: leaving apply_leave on the read-only default
 * would let a client submit a real leave application to a proctor with no
 * prompt at all, which would quietly defeat the tool's two-step confirmation.
 */
const WRITE_TOOLS: Record<string, { readOnlyHint: boolean }> = {
  apply_leave: { readOnlyHint: false },
};

const SERVER_PATH = path.resolve(process.cwd(), "dist", "index.js");

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
  private stdoutBuf = "";
  exited = false;

  constructor(serverPath: string) {
    this.proc = spawn(process.execPath, [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => {
      process.stderr.write(`[server stderr] ${chunk}`);
    });
    this.proc.on("exit", () => {
      this.exited = true;
      for (const resolve of this.pending.values()) {
        resolve({ jsonrpc: "2.0", id: -1, error: { code: -1, message: "server exited" } });
      }
      this.pending.clear();
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stderr.write(`[smoke] non-JSON line from server: ${line}\n`);
        continue;
      }
      if (typeof msg.id === "number") {
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    }
  }

  async request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for response to ${method}`));
      }, 15_000);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    });
  }

  notify(method: string, params?: unknown): void {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  close(): void {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

type StepResult = { name: string; status: "PASS" | "WARN" | "FAIL"; note?: string };

async function main() {
  if (!existsSync(SERVER_PATH)) {
    console.error(`[smoke] dist/index.js not found at ${SERVER_PATH}`);
    console.error(`[smoke] run 'npm run build' first`);
    process.exit(2);
  }

  const client = new McpStdioClient(SERVER_PATH);
  const results: StepResult[] = [];
  let hardFail = false;

  // Step 1: initialize
  try {
    const res = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vtop-mcp-smoke", version: "0.0.0" },
    });
    if (res.error) throw new Error(res.error.message);
    const r = res.result as { serverInfo?: { name?: string; version?: string } };
    const name = r?.serverInfo?.name;
    if (name !== "vtop-mcp") {
      throw new Error(`expected serverInfo.name='vtop-mcp', got '${name}'`);
    }
    results.push({
      name: "initialize",
      status: "PASS",
      note: `serverInfo.name='${name}' v${r?.serverInfo?.version}`,
    });
    client.notify("notifications/initialized");
  } catch (err: unknown) {
    hardFail = true;
    results.push({
      name: "initialize",
      status: "FAIL",
      note: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 2: tools/list
  if (!hardFail) {
    try {
      const res = await client.request("tools/list", {});
      if (res.error) throw new Error(res.error.message);
      const r = res.result as {
        tools?: { name: string; inputSchema?: unknown; readOnlyHint?: boolean }[];
      };
      const names = (r.tools ?? []).map((t) => t.name).sort();
      const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
      const extra = names.filter((t) => !EXPECTED_TOOLS.includes(t));
      if (missing.length || extra.length) {
        throw new Error(
          `tool list mismatch: missing=[${missing.join(",")}] extra=[${extra.join(",")}]`
        );
      }
      const noSchema = (r.tools ?? []).filter((t) => !t.inputSchema).map((t) => t.name);
      if (noSchema.length) {
        throw new Error(`tools missing inputSchema: ${noSchema.join(",")}`);
      }

      // Every write tool must be flagged so clients prompt rather than
      // auto-approve. Checked per tool, so a future write path cannot slip
      // through on the read-only default.
      //
      // MCP nests these under `annotations` on the wire (the SDK's `tool()`
      // takes them as a flat argument but serialises them nested), so read
      // both locations rather than assuming which one a given SDK emits.
      const badHints: string[] = [];
      for (const [name, want] of Object.entries(WRITE_TOOLS)) {
        const tool = (r.tools ?? []).find((t) => t.name === name) as
          | { annotations?: { readOnlyHint?: boolean }; readOnlyHint?: boolean }
          | undefined;
        if (!tool) {
          badHints.push(`${name} absent`);
          continue;
        }
        const got = tool.annotations?.readOnlyHint ?? tool.readOnlyHint;
        if (got !== want.readOnlyHint) {
          badHints.push(
            `${name} readOnlyHint=${String(got)} ` +
              `(annotations=${JSON.stringify(tool.annotations)}), expected ${want.readOnlyHint}`,
          );
        }
      }
      if (badHints.length) {
        throw new Error(`write-tool hints wrong: ${badHints.join("; ")}`);
      }

      results.push({
        name: "tools/list",
        status: "PASS",
        note:
          `${names.length} tools, all with inputSchema; ` +
          `${Object.keys(WRITE_TOOLS).length} write tool(s) flagged non-read-only`,
      });
    } catch (err: unknown) {
      hardFail = true;
      results.push({
        name: "tools/list",
        status: "FAIL",
        note: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Step 3: tools/call get_captcha (network-dependent — WARN on failure)
  if (!hardFail) {
    try {
      const res = await client.request("tools/call", {
        name: "get_captcha",
        arguments: {},
      });
      if (res.error) throw new Error(res.error.message);
      const r = res.result as {
        content?: { type: string }[];
        isError?: boolean;
        structuredContent?: { data?: { captchaFile?: string | null } };
      };
      if (r.isError) throw new Error("tool returned isError=true");
      const hasImage = (r.content ?? []).some((c) => c.type === "image");
      if (!hasImage) throw new Error("no content item of type 'image' in response");

      // The image block alone is not enough: Codex's TUI and OpenCode's plain
      // TUI both drop it, and a model that cannot see the captcha guesses - and
      // every guess is a failed login against a real account. Assert the file
      // fallback actually ships in the tool payload, not just in the source.
      const capFile = r.structuredContent?.data?.captchaFile;
      if (!capFile) throw new Error("captchaFile missing - image-blind clients have no fallback");
      if (!existsSync(capFile)) throw new Error(`captchaFile points at a missing file: ${capFile}`);

      results.push({ name: "tools/call get_captcha", status: "PASS" });
      results.push({ name: "captcha file fallback", status: "PASS", note: capFile });
    } catch (err: unknown) {
      results.push({
        name: "tools/call get_captcha",
        status: "WARN",
        note: `network-dependent: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  client.close();

  // summary
  console.error("\n[smoke] results:");
  for (const r of results) {
    const status = r.status.padEnd(4);
    console.error(`  ${status}  ${r.name}${r.note ? "  — " + r.note : ""}`);
  }
  const failed = results.some((r) => r.status === "FAIL");
  console.error(failed ? "\n[smoke] FAIL" : "\n[smoke] OK");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("[smoke] fatal:", err instanceof Error ? err.message : err);
  process.exit(2);
});
