/**
 * Captcha image conditioning.
 *
 * VTOP serves a 200x40 JPEG. That is fine in a browser, but several MCP
 * clients render it as a tall, illegible smear — the image arrives
 * stretched and the characters are unreadable, so every login attempt burns a
 * captcha on a guess.
 *
 * Fixing it server-side is better than asking the client to cope: upscale the
 * same image so it survives rendering, with no change to the pixels' meaning.
 * The captcha is still the one this client fetched and must submit — upscaling
 * does not create a second session or invalidate anything.
 *
 * Falls back to the original image if sharp is unavailable or fails, so this
 * can never be the reason a login fails.
 */

import type { VtopClient } from "./vtop-client.js";

/** Target upscale factor. 5x turns 200x40 into 1000x200. */
const DEFAULT_SCALE = 5;

/**
 * Minimal structural view of the sharp pipeline we use.
 *
 * sharp ships CJS with `export =`, and under NodeNext resolution its inferred
 * types don't line up with `(await import("sharp")).default`. Declaring just
 * the slice we actually call keeps this module independent of sharp's typings
 * and documents exactly what the dependency is used for.
 */
interface SharpMeta {
  width?: number;
  height?: number;
}
interface SharpChain {
  metadata(): Promise<SharpMeta>;
  resize(width: number, height: number, opts?: { kernel?: string }): SharpChain;
  jpeg(opts?: { quality?: number }): SharpChain;
  toBuffer(): Promise<Buffer>;
}
type SharpFn = (input: Buffer) => SharpChain;

function scale(): number {
  const raw = process.env.VTOP_CAPTCHA_SCALE;
  if (raw === undefined || raw.trim() === "") return DEFAULT_SCALE;
  const n = Number(raw);
  // 1 disables upscaling; anything else falls back to the default.
  return Number.isFinite(n) && n >= 2 ? Math.min(10, Math.floor(n)) : 1;
}

let sharpModule: SharpFn | null | undefined;

/** Load sharp lazily (it is a native module) and only once. */
async function getSharp(): Promise<SharpFn | null> {
  if (sharpModule !== undefined) return sharpModule;
  try {
    const mod = (await import("sharp")) as unknown as { default?: unknown };
    const fn = (mod.default ?? mod) as SharpFn;
    if (typeof fn !== "function") throw new Error("sharp did not export a callable");
    sharpModule = fn;
  } catch {
    sharpModule = null;
    console.error(
      "VtopMCP: sharp unavailable — captchas will be returned at original size, " +
        "which some MCP clients render too small to read. Install sharp to fix.",
    );
  }
  return sharpModule;
}

/**
 * Upscale a captcha data URL for legibility. Returns the original string
 * unchanged when disabled, when sharp is missing, or on any failure.
 */
export async function upscaleCaptcha(dataUrl: string): Promise<string> {
  const factor = scale();
  if (factor === 1) return dataUrl;

  const match = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!match) return dataUrl;
  const [, mime, b64] = match;

  try {
    const sharp = await getSharp();
    if (!sharp) return dataUrl;

    const input = Buffer.from(b64, "base64");
    const meta = await sharp(input).metadata();
    if (!meta.width || !meta.height) return dataUrl;

    const out = await sharp(input)
      // nearest keeps the thin, anti-aliased strokes crisp; a smooth kernel
      // blurs exactly the detail that distinguishes e.g. 8 from B.
      .resize(meta.width * factor, meta.height * factor, {
        kernel: "nearest",
      })
      .jpeg({ quality: 95 })
      .toBuffer();

    return `data:${mime};base64,${out.toString("base64")}`;
  } catch (err: unknown) {
    console.error(
      "VtopMCP: captcha upscale failed, returning original:",
      err instanceof Error ? err.message : err,
    );
    return dataUrl;
  }
}

/**
 * Report the captcha size actually delivered to the client, for logs.
 * Purely informational.
 */
export async function describeCaptchaSize(dataUrl: string): Promise<string> {
  try {
    const sharp = await getSharp();
    if (!sharp) return "size unknown (sharp unavailable)";
    const meta = await sharp(Buffer.from(dataUrl.split(",")[1] ?? "", "base64")).metadata();
    return `${meta.width}x${meta.height}`;
  } catch {
    return "size unknown";
  }
}

/** Re-export for convenience so callers need one import. */
export type { VtopClient };