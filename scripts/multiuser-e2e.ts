#!/usr/bin/env tsx
/**
 * End-to-end proof of the multi-user 404 fix.
 *
 * Reproduces the exact ChatGPT scenario: get_captcha and login arrive on TWO
 * DIFFERENT MCP sessions that share only the connector token. Before the fix,
 * login lands on a fresh, unarmed VtopClient and VTOP returns 404. After it,
 * the per-token shared client means login reuses the session get_captcha armed.
 *
 * Assumes the built server is already running locally, e.g.:
 *   $env:CONNECTOR_SECRET="local-debug-secret-1234"; $env:VTOP_INSECURE_TLS="1";
 *   $env:PORT="3939"; node dist/http.js
 *
 *   CONNECTOR_SECRET=local-debug-secret-1234 npx tsx scripts/multiuser-e2e.ts
 *
 * Reads VTOP_USERNAME / VTOP_PASSWORD from .env. Pauses for OCR via answer.txt.
 */
import "dotenv/config";
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { encryptCredentials } from "../src/services/crypto.js";

const PORT = process.env.PORT ?? "3939";
const DIR = path.resolve(process.cwd(), "test-output", "trace");
const ANSWER = path.join(DIR, "answer.txt");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function textOf(res: any): string {
  return (res?.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

async function newSession(url: string, label: string) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: `mu-e2e-${label}`, version: "0.0.0" });
  await client.connect(transport);
  // @ts-expect-error sessionId is exposed on the transport after connect
  console.log(`[${label}] connected, mcp-session-id=${transport.sessionId}`);
  return { client, transport };
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  if (existsSync(ANSWER)) rmSync(ANSWER);

  const user = process.env.VTOP_USERNAME;
  const pass = process.env.VTOP_PASSWORD;
  if (!user || !pass) throw new Error("Set VTOP_USERNAME / VTOP_PASSWORD in .env");
  if (!process.env.CONNECTOR_SECRET) throw new Error("Set CONNECTOR_SECRET (same as the server)");

  const token = encryptCredentials({ username: user, password: pass });
  const url = `http://localhost:${PORT}/mcp/${token}`;
  console.log(`Connector URL: http://localhost:${PORT}/mcp/<token len=${token.length}>`);

  // --- MCP session 1: get_captcha ---
  const s1 = await newSession(url, "session1");
  const cap = await s1.client.callTool({ name: "get_captcha", arguments: {} });
  const img = (cap as any).content?.find((c: any) => c.type === "image");
  if (!img) {
    console.log("[session1] get_captcha returned no image:", textOf(cap));
    await s1.client.close();
    process.exit(3);
  }
  const file = path.join(DIR, `mu-captcha.${(img.mimeType ?? "image/jpeg").split("/")[1]}`);
  writeFileSync(file, Buffer.from(img.data, "base64"));
  console.log(`[session1] captcha image -> ${file}`);
  // Close session 1 entirely so login cannot possibly reuse its MCP session.
  await s1.client.close();
  console.log("[session1] closed (MCP session gone)");

  console.log(`OCR the image, then: echo "<text>" > ${ANSWER}`);
  let captcha = "";
  for (let i = 0; i < 120; i++) {
    if (existsSync(ANSWER)) {
      captcha = readFileSync(ANSWER, "utf8").trim();
      if (captcha) break;
    }
    await sleep(1000);
  }
  if (!captcha) throw new Error("no captcha answer within 120s");

  // --- MCP session 2 (fresh): login ---
  const s2 = await newSession(url, "session2");
  console.log(`[session2] calling login with captcha="${captcha}" (different MCP session, same token)`);
  const res = await s2.client.callTool({
    name: "login",
    arguments: { captcha },
  });
  const msg = textOf(res);
  const isError = (res as any).isError === true;
  console.log("\n=== login result on SEPARATE MCP session ===");
  console.log("  isError:", isError);
  console.log("  message:", msg);

  if (!isError && /successfully logged in/i.test(msg)) {
    console.log("\n✅ FIX CONFIRMED: cross-session login succeeded (shared per-token client).");
    // bonus: a data call on session 2
    const prof = await s2.client.callTool({ name: "get_profile", arguments: {} });
    console.log("  get_profile isError:", (prof as any).isError === true,
      " bytes:", JSON.stringify((prof as any).content ?? "").length);
  } else if (/404/.test(msg)) {
    console.log("\n❌ Still 404 — shared client not taking effect.");
  } else {
    console.log("\n⚠️ Login did not succeed (check captcha / message above).");
  }
  await s2.client.close();
  rmSync(ANSWER, { force: true });
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
