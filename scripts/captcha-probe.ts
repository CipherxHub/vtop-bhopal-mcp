#!/usr/bin/env tsx
/**
 * Probe how often the live portal serves an OCR-able image captcha vs Google
 * reCAPTCHA, and report which error code we produce in each case.
 *
 * Read-only: it stops at the captcha and never submits credentials.
 *   npx tsx scripts/captcha-probe.ts [attempts]
 */
import { VtopClient } from "../src/services/vtop-client.js";
import { VtopError } from "../src/services/errors.js";

const attempts = Number(process.argv[2] ?? 5);
const client = new VtopClient();

let images = 0;
let recaptcha = 0;
let missing = 0;

for (let i = 1; i <= attempts; i++) {
  try {
    const img = await client.getCaptcha();
    images++;
    console.log(
      `attempt ${i}/${attempts}: IMAGE captcha OK (${img.slice(0, 32)}..., ${img.length} chars)`,
    );
  } catch (err: unknown) {
    const code = err instanceof VtopError ? err.code : "UNCLASSIFIED";
    if (code === "RECAPTCHA_REQUIRED") recaptcha++;
    else if (code === "CAPTCHA_NOT_FOUND") missing++;
    console.log(`attempt ${i}/${attempts}: ${code}`);
  }
  if (i < attempts) await new Promise((r) => setTimeout(r, 2000));
}

console.log(`\nimage=${images}  recaptcha=${recaptcha}  missing=${missing}`);
if (images > 0) {
  console.log("Image captcha is available — you can complete a live login now.");
} else {
  console.log(
    "No image captcha on any attempt. VTOP is scoring this IP as risky; a\n" +
      "residential proxy (VTOP_PROXY_URL) is the documented workaround.",
  );
}