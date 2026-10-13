import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Write the captcha JPEG to disk so clients that cannot render MCP `image`
 * content blocks can still get at it.
 *
 * Why this exists. `get_captcha` originally returned the captcha ONLY as an
 * `{ type: "image" }` content block. That works when the client renders image
 * blocks (Claude Desktop, OpenCode's code mode) and does nothing at all when it
 * does not (Codex's TUI, OpenCode's plain TUI). A client in the second group has
 * no way to obtain the captcha, and the failure mode is bad: the model sees a
 * caption saying "captcha retrieved", cannot see the image, and guesses a
 * plausible-looking string. Every guess is wrong, and each wrong guess is a
 * real failed login attempt against the student's VTOP account. This was
 * observed twice in the wild before this existed.
 *
 * The image block is still returned first. Clients that render it keep the
 * zero-friction path; everyone else is handed a real file they can open.
 *
 * The directory defaults to the OS temp dir rather than a path relative to
 * `process.cwd()`. A relative path is not safe here: the HTTP connector and
 * several MCP clients spawn the server with a working directory we do not
 * control, and an unwritable cwd would make login fail for a reason that has
 * nothing to do with VTOP. Override with VTOP_CAPTCHA_DIR.
 */

const DEFAULT_DIR = path.join(tmpdir(), "vtop-mcp-captcha");

/** Keep the newest N captchas so the directory cannot grow without bound. */
const KEEP = 10;

export function captchaDir(): string {
  return process.env.VTOP_CAPTCHA_DIR || DEFAULT_DIR;
}

/**
 * Persist a captcha and return the absolute path. Returns null if the write
 * fails — a read-only or missing temp dir must never break login, so this
 * degrades to the previous image-block-only behaviour rather than throwing.
 */
export function saveCaptchaFile(mimeType: string, base64: string): string | null {
  const dir = captchaDir();
  const ext = mimeType.includes("png") ? "png" : "jpg";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `captcha-${stamp}.${ext}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, Buffer.from(base64, "base64"));
    pruneOldCaptchas(dir);
    return file;
  } catch {
    return null;
  }
}

function pruneOldCaptchas(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith("captcha-"))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
      try {
        unlinkSync(path.join(dir, f));
      } catch {
        /* best effort only */
      }
    }
  } catch {
    /* best effort only */
  }
}
