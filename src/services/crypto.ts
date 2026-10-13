import crypto from "node:crypto";
import type { Credentials } from "../types/index.js";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KDF_SALT = "vtop-mcp-token-v1";
const MIN_SECRET_LEN = 16;

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
 */
export function encryptCredentials(creds: Credentials): string {
  return encryptString(JSON.stringify(creds));
}

/** Reverse of encryptCredentials. Throws if the token is malformed or forged. */
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
  return { username, password };
}
