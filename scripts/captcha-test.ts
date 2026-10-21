#!/usr/bin/env tsx
/**
 * Offline tests for the captcha conditioning pipeline.
 *   npm run test:captcha
 *
 * The pipeline matters: VTOP's captcha is coloured text on a light, grid-lined
 * background. A plain upscale magnified the noise along with the glyphs and
 * vision models misread it often enough to burn three login attempts against
 * a real student account. The conditioning must produce clean two-tone
 * output while keeping the strokes.
 */
import assert from "node:assert/strict";
import sharp from "sharp";
import { upscaleCaptcha } from "../src/services/captcha-image.js";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log("captcha conditioning (offline)");

/** A stand-in for VTOP's captcha: dark glyph strokes on a light, grid-lined, speckled background. */
async function fakeCaptcha(): Promise<Buffer> {
  const W = 200;
  const H = 40;
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="#f3f1ec"/>
    <g stroke="#dcd8cf" stroke-width="1">
      ${Array.from({ length: 20 }, (_, i) => `<line x1="0" y1="${i * 2}" x2="${W}" y2="${i * 2}"/>`).join("")}
      ${Array.from({ length: 40 }, (_, i) => `<line x1="${i * 5}" y1="0" x2="${i * 5}" y2="${H}"/>`).join("")}
    </g>
    <text x="18" y="30" font-family="monospace" font-size="26" font-weight="bold" fill="#8a1c14">Q7K2M</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

const toDataUrl = (b: Buffer) => `data:image/jpeg;base64,${b.toString("base64")}`;

check("conditioning turns a noisy captcha into two tones", async () => {
  const raw = await fakeCaptcha();
  const out = await upscaleCaptcha(toDataUrl(raw));
  const bytes = Buffer.from(out.split(",")[1] ?? "", "base64");
  const stats = await sharp(bytes).stats();
  // Binarised output: the channels collapse to a near-binary spread, so the
  // standard deviation across the pixels is large while the mean sits high
  // (mostly white background).
  assert.ok(stats.channels[0].stdev > 60, `expected a two-tone image, stdev=${stats.channels[0].stdev}`);
  assert.ok(stats.channels[0].mean > 120, `expected a light background, mean=${stats.channels[0].mean}`);
});

check("conditioning keeps the strokes (dark pixels survive)", async () => {
  const raw = await fakeCaptcha();
  const out = await upscaleCaptcha(toDataUrl(raw));
  const bytes = Buffer.from(out.split(",")[1] ?? "", "base64");
  const { data } = await sharp(bytes).greyscale().raw().toBuffer({ resolveWithObject: true });
  let dark = 0;
  for (const px of data) if (px < 100) dark++;
  const ratio = dark / data.length;
  // The glyphs are a small but real part of the frame. A pipeline that
  // thresholded too hard would erase them and hand the model a blank image.
  assert.ok(ratio > 0.01, `expected visible strokes, got ${(ratio * 100).toFixed(2)}% dark`);
  assert.ok(ratio < 0.6, `expected a mostly light frame, got ${(ratio * 100).toFixed(2)}% dark`);
});

check("conditioning is larger than the source and still decodes", async () => {
  const raw = await fakeCaptcha();
  const out = await upscaleCaptcha(toDataUrl(raw));
  const bytes = Buffer.from(out.split(",")[1] ?? "", "base64");
  const meta = await sharp(bytes).metadata();
  assert.ok(meta.width && meta.height, "the conditioned image must decode");
  assert.ok(meta.width! > 200, `expected an upscale, got ${meta.width}`);
});

check("a non-image payload is returned unchanged", async () => {
  const junk = "data:image/jpeg;base64,not-a-real-image";
  assert.equal(await upscaleCaptcha(junk), junk);
});

check("a data URL that is not an image is returned unchanged", async () => {
  const junk = "data:text/plain;base64,aGk=";
  assert.equal(await upscaleCaptcha(junk), junk);
});

console.log(`\n${passed} checks passed.`);
