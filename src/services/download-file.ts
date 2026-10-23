import { mkdirSync, writeFileSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Persist a downloaded VTOP file (syllabus PDF, curriculum PDF) to disk and
 * hand back the absolute path — the same pattern as get_captcha's
 * `captchaFile`: MCP tool results carry JSON well and binary badly, so the
 * bytes live in a file and the tool returns the path plus metadata.
 *
 * Directory defaults to the OS temp dir (never the repo: fixtures must stay
 * synthetic and downloads carry real data). Override with VTOP_DOWNLOAD_DIR.
 */

const DEFAULT_DIR = path.join(tmpdir(), "vtop-mcp-downloads");

/** Keep the newest N downloads per file kind so the directory cannot grow without bound. */
const KEEP = 20;

/** Extensions we are willing to write. Anything else is refused. */
const EXT_RE = /^[A-Za-z0-9]{1,8}$/;

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
  const extNoDot = ext.replace(/^\./, "");
  // The extension becomes part of the path: refuse anything that could
  // escape the download directory.
  if (!EXT_RE.test(extNoDot)) return null;
  const file = path.join(downloadDir(), `${safe}.${extNoDot}`);
  try {
    // Owner-only: these files carry a student's photo or course material.
    mkdirSync(downloadDir(), { recursive: true, mode: 0o700 });
    writeFileSync(file, bytes, { mode: 0o600 });
  } catch {
    return null;
  }
  // Prune AFTER the write, and never the file we just wrote.
  pruneOldDownloads(downloadDir(), extNoDot, file);
  return file;
}

/**
 * Keep the newest KEEP downloads of one kind. Sorted by modification time
 * (not alphabetically — a lexicographic sort deleted whichever file sorted
 * first, which could be the one just written, so the tool returned a path to
 * a file that no longer existed).
 */
function pruneOldDownloads(dir: string, ext: string, keepFile?: string): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(`.${ext}`))
      .map((f) => {
        try {
          return { f, m: statSync(path.join(dir, f)).mtimeMs };
        } catch {
          return { f, m: 0 };
        }
      })
      .sort((a, b) => a.m - b.m);
    // One slot belongs to the file just written.
    const limit = Math.max(0, files.length - (KEEP - 1));
    for (const { f } of files.slice(0, limit)) {
      const p = path.join(dir, f);
      if (keepFile && path.resolve(p) === path.resolve(keepFile)) continue;
      try {
        unlinkSync(p);
      } catch {
        /* best effort only */
      }
    }
  } catch {
    /* best effort only */
  }
}
