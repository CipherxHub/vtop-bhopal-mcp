/**
 * Structured error taxonomy for VTOP failures.
 *
 * Why this exists: previously every failure surfaced as an English paragraph
 * embedded in `Error.message`, and recovery was delegated to the chat model by
 * hoping it would read and obey a long instruction ("call get_captcha, then
 * login, then retry"). That is fragile — a model can paraphrase, skip, or
 * reorder those steps, and nothing downstream can branch on the failure.
 *
 * A VtopError carries a stable machine-readable `code` plus an ordered
 * `recovery` plan. Tools surface it as MCP `structuredContent`, so a client can
 * branch on `error.code` instead of pattern-matching prose. The human/model
 * hint is generated from the same data, so the two can never drift apart.
 */

/** Stable, machine-readable failure identifiers. */
export type VtopErrorCode =
  /** No local session, or VTOP reported the session dead mid-request. */
  | "NOT_AUTHENTICATED"
  /** Login was attempted but no username/password is available anywhere. */
  | "CREDENTIALS_REQUIRED"
  /** VTOP rejected the captcha text (OCR misread, or it expired). */
  | "INVALID_CAPTCHA"
  /** VTOP rejected the username/password pair. */
  | "INVALID_CREDENTIALS"
  /** VTOP says the account is locked. */
  | "ACCOUNT_LOCKED"
  /** VTOP says too many failed attempts; reset required in a browser. */
  | "MAX_LOGIN_ATTEMPTS"
  /** Captcha and login POST landed on different server sessions (VTOP 404). */
  | "SESSION_MISMATCH"
  /** VTOP served Google reCAPTCHA, which this server cannot read. */
  | "RECAPTCHA_REQUIRED"
  /** Login page loaded but contained no captcha image at all. */
  | "CAPTCHA_NOT_FOUND"
  /** Request exceeded VTOP_TIMEOUT_MS. */
  | "TIMEOUT"
  /** Connection refused / DNS / TLS failure reaching VTOP. */
  | "NETWORK"
  /**
   * The endpoint itself 404s. Deliberately distinct from NOT_AUTHENTICATED:
   * a mistyped or renamed path must not be reported as a dead session, or the
   * client throws away a perfectly good session and re-logs-in for nothing.
   */
  | "ENDPOINT_NOT_FOUND"
  /** Anything else that came back from VTOP or our own parsing of it. */
  | "UPSTREAM";

export interface VtopErrorBody {
  code: VtopErrorCode;
  /** Short human-readable summary. No recovery prose — that lives in `recovery`. */
  message: string;
  /** True when simply repeating the same call could plausibly succeed. */
  retryable: boolean;
  /** True when a human must supply something (credentials, a browser reset). */
  needsUserInput: boolean;
  /** Ordered tool names the client should call to recover. Empty = give up. */
  recovery: string[];
  /** Free-form diagnostic (page markers, underlying axios message). */
  detail?: string;
}

/** Ordered tool calls that resolve each code, and whether they're automatic. */
const RECOVERY: Record<
  VtopErrorCode,
  { recovery: string[]; retryable: boolean; needsUserInput: boolean }
> = {
  NOT_AUTHENTICATED: {
    recovery: ["get_captcha", "login"],
    retryable: false,
    needsUserInput: false,
  },
  CREDENTIALS_REQUIRED: {
    recovery: ["login"],
    retryable: false,
    needsUserInput: true,
  },
  INVALID_CAPTCHA: {
    recovery: ["get_captcha", "login"],
    retryable: false,
    needsUserInput: false,
  },
  INVALID_CREDENTIALS: { recovery: [], retryable: false, needsUserInput: true },
  ACCOUNT_LOCKED: { recovery: [], retryable: false, needsUserInput: true },
  MAX_LOGIN_ATTEMPTS: { recovery: [], retryable: false, needsUserInput: true },
  SESSION_MISMATCH: {
    recovery: ["get_captcha", "login"],
    retryable: false,
    needsUserInput: false,
  },
  RECAPTCHA_REQUIRED: {
    recovery: ["get_captcha", "login"],
    retryable: true,
    needsUserInput: false,
  },
  CAPTCHA_NOT_FOUND: {
    recovery: ["get_captcha", "login"],
    retryable: true,
    needsUserInput: false,
  },
  TIMEOUT: { recovery: [], retryable: true, needsUserInput: false },
  NETWORK: { recovery: [], retryable: true, needsUserInput: false },
  // Retrying an endpoint that does not exist will never help, and asking the
  // client to re-authenticate would be actively wrong — the session is fine.
  ENDPOINT_NOT_FOUND: {
    recovery: [],
    retryable: false,
    needsUserInput: false,
  },
  UPSTREAM: { recovery: [], retryable: true, needsUserInput: false },
};

/**
 * Short instruction for the chat model, derived from `recovery` rather than
 * hand-written per tool. Keeps the model-facing hint and the machine-facing
 * code in one place, so they can't drift.
 */
const MODEL_HINT: Partial<Record<VtopErrorCode, string>> = {
  CREDENTIALS_REQUIRED:
    'No VTOP credentials are configured. Ask the user directly, in ONE short line: "What\'s your VTOP username and password?" Then call login with them plus the SAME captcha you already have — the captcha was never submitted, so it is still valid. Do NOT present numbered options, do NOT explain env-var configuration.',
  INVALID_CREDENTIALS:
    "VTOP rejected the username/password. Tell the user plainly and ask them to double-check it against the VTOP website. Do not retry the same pair more than once.",
  ACCOUNT_LOCKED:
    "VTOP says the account is locked. Tell the user to contact VIT administration. Retrying will not help.",
  MAX_LOGIN_ATTEMPTS:
    "VTOP has locked out further attempts. Tell the user to log in once via the VTOP website to reset, then retry here.",
  ENDPOINT_NOT_FOUND:
    "This VTOP endpoint does not exist (HTTP 404). The session is still valid - do NOT log in again. " +
    "The backend path is wrong or has been renamed, so this feature cannot be reached; report that rather than retrying.",
};

/**
 * An error with a machine-readable code and an ordered recovery plan.
 *
 * The message is prefixed with the code so that older `message.startsWith(code)`
 * checks (and any external scripts) keep working unchanged.
 */
export class VtopError extends Error {
  readonly code: VtopErrorCode;
  readonly detail?: string;

  constructor(code: VtopErrorCode, message: string, detail?: string) {
    super(`${code}: ${message}`);
    this.name = "VtopError";
    this.code = code;
    this.detail = detail;
  }

  toBody(): VtopErrorBody {
    const policy = RECOVERY[this.code];
    return {
      code: this.code,
      message: this.message.slice(this.code.length + 2), // strip the "CODE: " prefix
      retryable: policy.retryable,
      needsUserInput: policy.needsUserInput,
      recovery: [...policy.recovery],
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

/** Narrow an unknown thrown value to a VtopError, or null. */
export function asVtopError(err: unknown): VtopError | null {
  return err instanceof VtopError ? err : null;
}

/**
 * True when the failure is a dead/absent session. Accepts a VtopError, a plain
 * Error whose message carries a code prefix (legacy shape), or nothing.
 */
export function isNotAuthenticated(err: unknown): boolean {
  if (err instanceof VtopError) return err.code === "NOT_AUTHENTICATED";
  return err instanceof Error && err.message.startsWith("NOT_AUTHENTICATED");
}

/**
 * Map an arbitrary thrown value onto the taxonomy. Anything we didn't raise
 * ourselves is classified from its axios shape, so connection problems stop
 * masquerading as "upstream parse error".
 */
export function classify(err: unknown): VtopError {
  if (err instanceof VtopError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.startsWith("NOT_AUTHENTICATED")) {
    return new VtopError("NOT_AUTHENTICATED", msg.slice("NOT_AUTHENTICATED: ".length));
  }
  if (/timeout of \d+ms exceeded|ECONNABORTED/i.test(msg)) {
    return new VtopError("TIMEOUT", "VTOP did not respond in time.", msg);
  }
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|certificate|self.signed/i.test(msg)) {
    return new VtopError("NETWORK", "Could not reach VTOP.", msg);
  }
  return new VtopError("UPSTREAM", msg);
}

/** One-line, model-facing rendering of a body. Safe to append to tool text. */
export function describeForModel(body: VtopErrorBody): string {
  const hint = MODEL_HINT[body.code];
  const parts = [`${body.code}: ${body.message}`];
  if (hint) parts.push(hint);
  else if (body.recovery.length > 0) {
    parts.push(`Recover by calling ${body.recovery.join(" -> ")}, then retry.`);
  }
  if (body.detail) parts.push(`Diagnostic: ${body.detail}`);
  return parts.join("\n");
}