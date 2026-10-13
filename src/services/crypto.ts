import crypto from "node:crypto";
import type { Credentials } from "../types/index.js";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KDF_SALT = "vtop-mcp-token-v1";
const MIN_SECRET_LEN = 16;
/** Connector token version with expiry (issue #4). v1 tokens carry no exp. */
const TOKEN_VERSION = 2;
/** Days a newly issued connector token stays valid. Override with CONNECTOR_TOKEN_TTL_DAYS. */
function tokenTtlMs(): number {
  const days = Number(process.env.CONNECTOR_TOKEN_TTL_DAYS ?? 90);
  const sane = !Number.isFinite(days) || days <= 0 ? 90 : Math.min(days, 3650);
  if (sane > 365) {
    console.error(`VtopMCP: CONNECTOR_TOKEN_TTL_DAYS=${sane} — tokens live over a year; prefer 90 or less.`);
  }
  return sane * 24 * 3600 * 1000;
}

let cachedKey: Buffer | null = null;

/**
 * Multi-user mode is enabled when CONNECTOR_SECRET is configured. Without it the
 * server stays single-user (env-var credentials or the in-chat login flow).
 */
export function isMultiUserEnabled(): boolean {
  const s = process.env.CONNECTOR_SECRET;
  return typeof s === "string" && s.length >= MIN_SECRET_LEN;
}

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.CONNECTOR_SECRET;
  if (!secret || secret.length < MIN_SECRET_LEN) {
    throw new Error(
      `CONNECTOR_SECRET must be set to a random string of at least ${MIN_SECRET_LEN} characters to use multi-user tokens.`,
    );
  }
  cachedKey = crypto.scryptSync(secret, KDF_SALT, 32);
  return cachedKey;
}

/**
 * Encrypt an arbitrary string into an opaque, URL-safe token (AES-256-GCM).
 * Self-contained ciphertext keyed by CONNECTOR_SECRET — used both for the
 * credential tokens in connector URLs and for persisted session blobs.
 */
export function encryptString(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

/** Reverse of encryptString. Throws if the token is malformed or forged. */
export function decryptString(token: string): string {
  const key = getKey();
  const raw = Buffer.from(token, "base64url");
  if (raw.length <= IV_LEN + TAG_LEN) {
    throw new Error("Token is too short to be valid.");
  }
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

/**
 * Encrypt VTOP credentials into an opaque, URL-safe token. The token is fully
 * self-contained ciphertext (AES-256-GCM) — nothing is stored server-side, so
 * the deployment needs no database. Only a holder of CONNECTOR_SECRET can
 * decrypt it.
 *
 * v2 tokens carry iat/exp so a leaked URL stops working (issue #4). Treat the
 * connector URL as a secret: it lands in proxy logs and Referer headers.
 */
export function encryptCredentials(creds: Credentials): string {
  const now = Date.now();
  return encryptString(
    JSON.stringify({
      username: creds.username,
      password: creds.password,
      v: TOKEN_VERSION,
      iat: now,
      exp: now + tokenTtlMs(),
    }),
  );
}

/**
 * Reverse of encryptCredentials. Throws if the token is malformed, forged, or
 * expired. Legacy v1 tokens (no exp) are accepted until CONNECTOR_V1_SUNSET so
 * a deploy does not log out every user at once — re-register for a v2 token.
 */
export function decryptCredentials(token: string): Credentials {
  const obj: unknown = JSON.parse(decryptString(token));
  if (
    !obj ||
    typeof obj !== "object" ||
    typeof (obj as Credentials).username !== "string" ||
    typeof (obj as Credentials).password !== "string"
  ) {
    throw new Error("Token payload is malformed.");
  }
  const { username, password } = obj as Credentials;
  const exp = (obj as { exp?: unknown }).exp;
  if (exp === undefined) {
    const sunset = Date.parse(process.env.CONNECTOR_V1_SUNSET ?? "2027-01-01T00:00:00Z");
    if (!warnedV1) {
      warnedV1 = true;
      console.error(
        "VtopMCP: legacy v1 connector token used (no expiry) — re-register at /register for an expiring v2 token.",
      );
    }
    if (Number.isFinite(sunset) && Date.now() > sunset) {
      throw new Error("Legacy v1 connector token retired. Re-register at /register to get a new one.");
    }
  } else if (typeof exp !== "number" || !Number.isFinite(exp) || Date.now() > exp) {
    throw new Error("Connector token has expired. Re-register at /register to get a new one.");
  }
  return { username, password };
}

let warnedV1 = false;
