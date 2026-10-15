import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Persist a downloaded VTOP file (syllabus PDF, curriculum PDF) to disk and
 * hand back the absolute path — the same回答 pattern as get_captcha's
 * `captchaFile`: MCP tool results carry JSON well and binary badly, so the
 * bytes live in a file and the tool returns the path plus metadata.
 *
 * Directory defaults to the OS temp dir (never the repo: fixtures must stay
 * synthetic and downloads carry real data). Override with VTOP_DOWNLOAD_DIR.
 */

const DEFAULT_DIR = path.join(tmpdir(), "vtop-mcp-downloads");

/** Keep the newest N downloads so the directory cannot grow without bound. */
const KEEP = 20;

export function downloadDir(): string {
  return process.env.VTOP_DOWNLOAD_DIR || DEFAULT_DIR;
}

/**
 * Save bytes under a caller-chosen base name (sanitised to a flat filename)
 * and return the absolute path. Returns null if the write fails — a
 * read-only temp dir must degrade to an error naming the problem, never a
 * crash with no path forward.
 */
export function saveDownloadFile(
  baseName: string,
  ext: string,
  bytes: Buffer,
): string | null {
  const safe = baseName.replace(/[^A-Za-z0-9-_]+/g, "-").slice(0, 80) || "download";
  const file = path.join(downloadDir(), `${safe}.${ext.replace(/^\./, "")}`);
  try {
    mkdirSync(downloadDir(), { recursive: true });
    writeFileSync(file, bytes);
    pruneOldDownloads(downloadDir());
    return file;
  } catch {
    return null;
  }
}

function pruneOldDownloads(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".pdf"))
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
