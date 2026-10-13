#!/usr/bin/env tsx
/**
 * Diagnostic: fetch VTOP's prelogin page and report how the captcha is served
 * (embedded base64 image, a separate image URL, or Google reCAPTCHA). No
 * credentials needed — it only loads the public login page.
 *
 *   npx tsx scripts/captcha-debug.ts
 *
 * Writes the full page to captcha-page.html for inspection.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { VtopClient } from "../src/services/vtop-client.js";

const client = new VtopClient();
const html = await client.debugLoginPageHtml();

writeFileSync("captcha-page.html", html);

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const block = html.match(/id="captchaBlock"[\s\S]{0,500}/i)?.[0];
const sitekey = html.match(/data-sitekey="([^"]+)"/i)?.[1];
const imgSrcs = [...html.matchAll(/<img[^>]+src="([^"]{0,70})/gi)].map((m) => m[1]);

console.log("\n================ VTOP captcha diagnostic ================");
console.log("page length     :", html.length);
console.log("title           :", html.match(/<title[^>]*>([^<]*)</i)?.[1]?.trim());
console.log("base64 image?   :", /src="data:image/i.test(html));
console.log("reCAPTCHA?       :", /g-recaptcha|recaptcha\//i.test(html));
console.log("reCAPTCHA sitekey:", sitekey ?? "none");
console.log("g-recaptcha-response field present:", /g-recaptcha-response/i.test(html));
console.log("captchaStr field present          :", /name="captchaStr"/i.test(html));
console.log("\n--- first 12 <img> srcs ---");
imgSrcs.slice(0, 12).forEach((s) => console.log("  ", s + (s.length >= 70 ? "…" : "")));
console.log("\n--- #captchaBlock region (cleaned, 500 chars) ---");
console.log(block ? clean(block) : "(captchaBlock not found)");

const actions = [...html.matchAll(/action\s*=\s*"([^"]+)"/gi)].map((m) => m[1]);
const inputs = [...html.matchAll(/<input[^>]*?name\s*=\s*"([^"]+)"/gi)].map((m) => m[1]);
const loginForm = html.match(/<form[^>]*action="[^"]*login[^"]*"[^>]*>/i)?.[0];
console.log("\n--- form actions ---");
console.log(actions.length ? actions.join("\n") : "(none found)");
console.log("\n--- login <form> tag ---");
console.log(loginForm ? clean(loginForm) : "(no form whose action contains 'login')");
console.log("\n--- input field names ---");
console.log(inputs.length ? [...new Set(inputs)].join(", ") : "(none found)");

console.log("\nFull page saved to captcha-page.html");
console.log("========================================================\n");
