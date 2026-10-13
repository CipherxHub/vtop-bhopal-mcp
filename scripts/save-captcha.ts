#!/usr/bin/env tsx
/**
 * Fetch a live VTOP captcha and save it to test-output/live-captcha.jpg so it
 * can be read (by a human or a vision model) and submitted with the `login`
 * tool. Never submits credentials itself.
 *
 *   npx tsx scripts/save-captcha.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { VtopClient } from "../src/services/vtop-client.js";

const outDir = path.resolve("test-output");
mkdirSync(outDir, { recursive: true });

const client = new VtopClient();
const dataUrl = await client.getCaptcha();
const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
const buf = Buffer.from(b64, "base64");
const out = path.join(outDir, "live-captcha.jpg");
writeFileSync(out, buf);
console.log(`wrote ${out} (${buf.length} bytes)`);
console.log("Read the characters from the image, then call login with them.");