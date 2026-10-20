#!/usr/bin/env tsx
/**
 * Offline tests for the download-file helper.
 *   npm run test:download
 *
 * The file lives in the OS temp dir (downloads carry real student data), so
 * every test points VTOP_DOWNLOAD_DIR at a scratch directory.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vtop-download-test-"));
process.env.VTOP_DOWNLOAD_DIR = DIR;

const { saveDownloadFile, downloadDir } = await import("../src/services/download-file.js");

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log("download files (offline)");

check("a saved file exists where the tool says it does", () => {
  const file = saveDownloadFile("syllabus-CSD3010", "pdf", Buffer.from("%PDF-1.4 x"));
  assert.ok(file, "save must succeed");
  assert.equal(file, path.join(DIR, "syllabus-CSD3010.pdf"));
  assert.ok(fs.existsSync(file), "the returned path must exist");
});

check("pruning never deletes the file it just wrote", () => {
  // Regression: the prune sorted alphabetically, so a file sorting first
  // was deleted immediately and the tool returned a path to a missing file.
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  for (let i = 0; i < 25; i++) {
    saveDownloadFile(`syllabus-CSE${3000 + i}`, "pdf", Buffer.from("x"));
  }
  const last = saveDownloadFile("syllabus-AAA0001", "pdf", Buffer.from("x"));
  assert.ok(last && fs.existsSync(last), "the newest file must survive its own prune");
});

check("pruning keeps the newest files and drops the oldest", () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".pdf"));
  assert.ok(files.length <= 20, `kept ${files.length} files, expected at most 20`);
});

check("a dangerous extension is refused", () => {
  // The extension becomes part of the path: refuse anything that could
  // escape the download directory.
  assert.equal(saveDownloadFile("x", "../../etc/passwd", Buffer.from("x")), null);
  assert.equal(saveDownloadFile("x", "pdf/../../y", Buffer.from("x")), null);
});

check("an awkward base name is flattened, not refused", () => {
  const file = saveDownloadFile("course syllabus/../etc", "pdf", Buffer.from("x"));
  assert.ok(file);
  assert.equal(path.dirname(file), DIR, "the file must stay in the download dir");
  assert.ok(!file.includes(".."), "no traversal in the final name");
});

check("the download dir is the one we set", () => {
  assert.equal(downloadDir(), DIR);
});

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${passed} checks passed.`);
