#!/usr/bin/env tsx
/**
 * Two-phase REAL login tracer — pinpoints exactly where POST /vtop/login 404s
 * on the SUCCESS path (the only path dummy-credential probes can't reach).
 *
 * The cookie jar is persisted to disk between phases so the captcha's session
 * survives the gap while the captcha is read out of band.
 *
 *   Phase 1 — arm session + fetch captcha image:
 *     npx tsx scripts/login-trace.ts phase1
 *     (writes test-output/trace/captcha.<ext>, jar.json, state.json)
 *
 *   Phase 2 — submit real creds + the captcha text, trace every redirect hop:
 *     npx tsx scripts/login-trace.ts phase2 <captchaText>
 *     (reads VTOP_USERNAME / VTOP_PASSWORD from .env)
 *
 * No credentials are needed for phase 1. The password is read from .env in
 * phase 2 and never printed.
 */
import "dotenv/config";
import { CookieJar } from "tough-cookie";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { applySystemCATrust } from "../src/services/tls.js";

const BASE = process.env.VTOP_BASE_URL ?? "https://vtopcc.vit.ac.in/vtop";
const ORIGIN = new URL(BASE).origin;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DIR = path.resolve(process.cwd(), "test-output", "trace");

applySystemCATrust();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const CSRF_RE =
  /name="_csrf"\s+(?:content|value)="([^"]+)"|value="([^"]+)"\s+name="_csrf"/;
const csrfOf = (h: string) => h.match(CSRF_RE)?.[1] ?? h.match(CSRF_RE)?.[2] ?? "";

function makeReq(jar: CookieJar) {
  return async function req(method: string, target: string, body?: string) {
    const url = target.startsWith("http")
      ? target
      : target.startsWith("/")
        ? ORIGIN + target
        : BASE + "/" + target;
    const cookie = await jar.getCookieString(url);
    const headers: Record<string, string> = {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      Referer: BASE + "/login",
      Cookie: cookie,
    };
    if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const res = await fetch(url, { method, headers, body, redirect: "manual" });
    for (const c of res.headers.getSetCookie?.() ?? [])
      await jar.setCookie(c, url).catch(() => {});
    return res;
  };
}

async function follow(
  req: ReturnType<typeof makeReq>,
  res: Response,
  label: string,
): Promise<{ final: Response; body: string }> {
  let cur = res;
  let loc = cur.headers.get("location");
  const setc = cur.headers.getSetCookie?.() ?? [];
  console.log(
    `${label}: ${cur.status}${loc ? ` => ${loc}` : ""}${setc.length ? `  [+${setc.length} cookie]` : ""}`,
  );
  let hop = 0;
  while (loc && hop++ < 8) {
    cur = await req("GET", loc);
    const sc = cur.headers.getSetCookie?.() ?? [];
    const nextLoc = cur.headers.get("location");
    console.log(
      `   ↳ GET ${loc.replace(ORIGIN, "")} -> ${cur.status}${nextLoc ? ` => ${nextLoc}` : ""}${sc.length ? `  [+${sc.length} cookie]` : ""}`,
    );
    loc = nextLoc;
  }
  return { final: cur, body: await cur.text() };
}

async function phase1() {
  mkdirSync(DIR, { recursive: true });
  const jar = new CookieJar();
  const req = makeReq(jar);

  console.log("=== PHASE 1: arm session + fetch captcha ===");
  const land = await req("GET", "/vtop/login");
  let html = await land.text();
  let csrf = csrfOf(html);
  console.log(`GET /login: ${land.status}  csrf=${csrf.slice(0, 8)}`);

  const setup = await req(
    "POST",
    "/vtop/prelogin/setup",
    new URLSearchParams({ flag: "VTOP", _csrf: csrf }).toString(),
  );
  const { body } = await follow(req, setup, "POST /prelogin/setup");
  html = body;
  csrf = csrfOf(html) || csrf;

  const m =
    html.match(
      /id="captchaBlock"[^>]*>[\s\S]*?<img[^>]+src="(data:image\/[^;]+;base64,[^"]+)"/,
    ) ??
    html.match(/<img[^>]+src="(data:image\/(?:png|jpeg|jpg);base64,[A-Za-z0-9+/=]+)"/);
  const sitekey = html.match(/data-sitekey="([^"]+)"/)?.[1];

  if (!m) {
    console.log(
      `\nNo image captcha. sitekey=${sitekey ?? "none"} captchaStr=${/name="captchaStr"/.test(html)} len=${html.length}`,
    );
    console.log("VTOP is serving the reCAPTCHA variant right now — rerun phase1 shortly.");
    process.exit(3);
  }

  const [, dataUrl] = m;
  const im = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/)!;
  const file = path.join(DIR, `captcha.${im[1]}`);
  writeFileSync(file, Buffer.from(im[2], "base64"));
  writeFileSync(path.join(DIR, "jar.json"), JSON.stringify(jar.serializeSync()));
  writeFileSync(path.join(DIR, "state.json"), JSON.stringify({ csrf }));
  console.log(`\nArmed. csrf=${csrf.slice(0, 8)} captchaStr=${/name="captchaStr"/.test(html)}`);
  console.log(`Captcha image -> ${file}`);
  console.log("Read that image, then run: npx tsx scripts/login-trace.ts phase2 <captchaText>");
}

async function phase2(captcha: string) {
  const user = process.env.VTOP_USERNAME;
  const pass = process.env.VTOP_PASSWORD;
  if (!user || !pass) {
    console.error("Set VTOP_USERNAME and VTOP_PASSWORD in .env first.");
    process.exit(2);
  }
  const jar = CookieJar.deserializeSync(
    JSON.parse(readFileSync(path.join(DIR, "jar.json"), "utf8")),
  );
  const { csrf } = JSON.parse(readFileSync(path.join(DIR, "state.json"), "utf8"));
  const req = makeReq(jar);

  console.log("=== PHASE 2: real login + redirect trace ===");
  console.log(`user=${user}  captcha="${captcha}"  csrf=${csrf.slice(0, 8)}`);
  const form = new URLSearchParams();
  form.append("username", user);
  form.append("password", pass);
  form.append("captchaStr", captcha);
  form.append("gResponse", captcha);
  form.append("_csrf", csrf);

  const res = await req("POST", "/vtop/login", form.toString());
  const { final, body } = await follow(req, res, "\nPOST /login");

  console.log(`\nFINAL: status=${final.status} url=${final.url} len=${body.length}`);
  const lower = body.toLowerCase();
  const flags: string[] = [];
  if (/authorizedidx/i.test(body)) flags.push("authorizedIDX ✅ SUCCESS");
  if (/invalid\s*captcha/.test(lower)) flags.push("invalid-captcha");
  if (/invalid\s*(user\s*name|login\s*id|user\s*id)\s*\/\s*password/.test(lower))
    flags.push("invalid-user/pass");
  if (/account\s*is\s*locked/.test(lower)) flags.push("account-locked");
  if (final.status === 404) flags.push("404 ⚠️ REPRODUCED");
  console.log("flags:", flags.join(", ") || "(none)");
  console.log("title:", body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim());
  writeFileSync(path.join(DIR, "login-result.html"), body);
  console.log(`\nFull final body -> ${path.join(DIR, "login-result.html")}`);
}

const mode = process.argv[2];
const arg = process.argv.slice(3).join(" ").trim();
if (mode === "phase1") await phase1();
else if (mode === "phase2") {
  if (!arg) {
    console.error('Usage: npx tsx scripts/login-trace.ts phase2 "<captchaText>"');
    process.exit(2);
  }
  await phase2(arg);
} else {
  console.error("Usage: login-trace.ts phase1 | phase2 <captchaText>");
  process.exit(2);
}
