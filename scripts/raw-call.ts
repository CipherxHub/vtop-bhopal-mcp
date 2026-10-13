#!/usr/bin/env tsx
/**
 * Raw JSON-RPC probe: call a tool through the MCP stdio transport and print
 * the COMPLETE CallToolResult, so we can see exactly what the server sends
 * (text vs structuredContent) without a client in the way.
 *
 *   npx tsx scripts/raw-call.ts get_attendance
 */
import { spawn } from "node:child_process";

const tool = process.argv[2] ?? "get_attendance";
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const child = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "pipe"] });
let buffer = "";
const pending = new Map<number, (v: unknown) => void>();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx: number;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {
      /* non-JSON noise */
    }
  }
});
child.stderr.on("data", () => {}); // suppress server logs

const call = (method: string, params?: unknown) =>
  new Promise<any>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

await call("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "raw-probe", version: "1" },
});
child.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
);

const res = await call("tools/call", { name: tool, arguments: args });
console.log(JSON.stringify(res.result, null, 2));
child.kill();
process.exit(0);