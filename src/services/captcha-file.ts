import { mkdirSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
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

/**
 * Hands-on convenience for clients whose model cannot read a local image.
 *
 * Codex's TUI renders no MCP `image` content blocks, and its model will not open
 * a file to look at one either — so on that client the captcha round trip needs a
 * human. With `VTOP_CAPTCHA_OPEN=1` the server opens the JPEG itself the moment it
 * is written, so the only thing left to do is read it off the screen and type it
 * back. That keeps the whole exchange inside the one MCP session, which a
 * standalone helper script cannot do: it spawns its own server, and its login
 * lands somewhere the assistant never sees.
 *
 * OFF BY DEFAULT. This makes the server spawn a GUI process on the host, which is
 * fine for a local single-user stdio server and wrong for a shared connector where
 * one process serves many people and every call would throw a window on whoever is
 * sitting at the keyboard. Set it for stdio, leave it unset for the HTTP connector.
 *
 * Returns true only if a viewer was actually launched. Never throws: login must
 * not depend on a desktop being available (a headless box, an SSH session, a
 * container all have no viewer, and there the file path is still the answer).
 */
export function isCaptchaOpenEnabled(): boolean {
  return process.env.VTOP_CAPTCHA_OPEN === "1";
}

/**
 * Build the platform's viewer invocation. Exported separately so it can be
 * asserted without spawning a real GUI process during tests.
 *
 * The path is always one we generated inside a directory we control — it never
 * contains user input — and it is passed as a distinct argv element with
 * `shell: false`, so there is no string interpolation to get wrong.
 */
export function captchaOpenCommand(
  file: string,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } | null {
  if (platform === "win32") {
    // `start` is a cmd.exe builtin, so cmd has to be invoked directly. The empty
    // "" is the window title `start` would otherwise steal from the path.
    return { cmd: "cmd", args: ["/c", "start", "", file] };
  }
  if (platform === "darwin") {
    return { cmd: "open", args: [file] };
  }
  if (platform === "linux") {
    return { cmd: "xdg-open", args: [file] };
  }
  return null;
}

export function openCaptchaImage(file: string): boolean {
  if (!isCaptchaOpenEnabled() || !existsSync(file)) return false;
  const invocation = captchaOpenCommand(file);
  if (!invocation) return false;
  try {
    const child = spawn(invocation.cmd, invocation.args, {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    // Detach so the viewer outlives this call and does not keep the MCP server's
    // stdio pipes open, which would deadlock the transport.
    child.unref();
    return true;
  } catch {
    return false;
  }
}
