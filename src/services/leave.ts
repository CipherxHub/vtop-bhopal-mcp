/**
 * Hostel leave rules — pure validation, no network, fully unit-testable.
 *
 * VTOP's leave form takes: leaveCode, visitingPlace, leaveFromDate, fromTime,
 * leaveToDate, toTime, reason. This module decides whether a request is
 * *coherent* before anything is sent, so a malformed leave never reaches the
 * proctor and has to be withdrawn.
 *
 * The one rule VTOP does not state anywhere on the form comes from the student:
 * a DAY OUTING (OG1) must be back by 18:00. It applies to DAY OUTING only —
 * their own history shows a SPECIAL OUTING approved at 18:30 — and 18:00
 * itself is allowed.
 *
 * Dates are handled as plain ISO `YYYY-MM-DD` strings and times as `HH:MM`.
 * Keeping them as strings avoids the timezone drift that silently shifts a
 * leave by a day when a `Date` is formatted in the local zone.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DAY_OUTING_LATEST_RETURN, LEAVE_MAX_DAYS } from "./constants.js";

/** ISO date, e.g. 2026-10-20. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** 24-hour clock, e.g. 18:00. */
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type LeaveSeverity = "error" | "warning";

export interface LeaveIssue {
  field: string;
  severity: LeaveSeverity;
  message: string;
}

export interface LeaveRequest {
  /** Leave type code: SO, WP, EP, SV, WV, HT1, LG1, EY1, OG1. */
  leaveCode: string;
  visitingPlace: string;
  /** ISO YYYY-MM-DD */
  leaveFromDate: string;
  /** HH:MM, 24-hour */
  fromTime: string;
  /** ISO YYYY-MM-DD */
  leaveToDate: string;
  /** HH:MM, 24-hour */
  toTime: string;
  reason: string;
}

export interface LeaveValidation {
  valid: boolean;
  issues: LeaveIssue[];
  /** Whole days the leave spans, inclusive of the from date. */
  durationDays: number | null;
  /** True when the 6 PM DAY OUTING rule was the thing that blocked it. */
  blockedByDayOutingRule: boolean;
}

/** VTOP caps visitingPlace at maxlength=150. */
export const VISITING_PLACE_MAX = 150;

const err = (field: string, message: string): LeaveIssue => ({
  field,
  severity: "error",
  message,
});
const warn = (field: string, message: string): LeaveIssue => ({
  field,
  severity: "warning",
  message,
});

/** Minutes since midnight, or null when the time is not `HH:MM`. */
export function minutesOfDay(hhmm: string): number | null {
  const m = HH_MM.exec(hhmm.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Whole days from `from` to `to`, inclusive.
 * Null when either date is malformed OR the range runs backwards — a negative
 * span is not a duration, and reporting one would let a reversed range look
 * like a valid (if short) leave.
 */
export function durationDaysInclusive(
  fromISO: string,
  toISO: string,
): number | null {
  if (!ISO_DATE.test(fromISO) || !ISO_DATE.test(toISO)) return null;
  const from = Date.parse(`${fromISO}T00:00:00Z`);
  const to = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  const days = Math.round((to - from) / 86_400_000) + 1;
  return days >= 1 ? days : null;
}

/** Normalise a user-supplied time to HH:MM. Accepts 6:00 PM, 18.00, 1800. */
export function normaliseTime(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  const ampm = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i.exec(raw);
  if (ampm) {
    let hour = Number(ampm[1]);
    const minute = ampm[2] ? Number(ampm[2]) : 0;
    if (hour < 1 || hour > 12 || minute > 59) return null;
    const upper = ampm[3].toUpperCase();
    if (upper === "A") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  // 24-hour, with or without a separator.
  const h24 = /^(\d{1,2})[:.]?(\d{2})$/.exec(raw);
  if (h24) {
    const hour = Number(h24[1]);
    const minute = Number(h24[2]);
    if (hour > 23 || minute > 59) return null;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  return null;
}

/**
 * Validate a leave request against every rule we know.
 *
 * `knownTypes` is the set of codes VTOP actually published, so a typo'd or
 * retired leave code is caught here instead of by VTOP's silence.
 */
export function validateLeave(
  req: LeaveRequest,
  opts: { todayISO: string; knownTypes: readonly string[] },
): LeaveValidation {
  const issues: LeaveIssue[] = [];
  const today = opts.todayISO;

  if (!opts.knownTypes.includes(req.leaveCode)) {
    issues.push(
      err(
        "leaveCode",
        `"${req.leaveCode}" is not a leave type VTOP offers. Known: ${opts.knownTypes.join(", ")}.`,
      ),
    );
  }

  const place = req.visitingPlace.trim();
  if (!place) {
    issues.push(err("visitingPlace", "Visiting place is required."));
  } else if (place.length > VISITING_PLACE_MAX) {
    issues.push(
      err(
        "visitingPlace",
        `Visiting place is ${place.length} characters; VTOP allows ${VISITING_PLACE_MAX}.`,
      ),
    );
  }

  const reason = req.reason.trim();
  if (!reason) {
    issues.push(err("reason", "Reason is required."));
  } else if (reason.length < 10) {
    issues.push(
      warn(
        "reason",
        "Reason is very short; the proctor may query a one-word reason.",
      ),
    );
  }

  // Dates.
  if (!ISO_DATE.test(req.leaveFromDate)) {
    issues.push(
      err("leaveFromDate", `From date must be YYYY-MM-DD, got "${req.leaveFromDate}".`),
    );
  } else if (req.leaveFromDate < today) {
    issues.push(
      err(
        "leaveFromDate",
        `From date ${req.leaveFromDate} is in the past (today is ${today}).`,
      ),
    );
  }
  if (!ISO_DATE.test(req.leaveToDate)) {
    issues.push(
      err("leaveToDate", `To date must be YYYY-MM-DD, got "${req.leaveToDate}".`),
    );
  }

  // Times.
  const fromMin = minutesOfDay(req.fromTime);
  const toMin = minutesOfDay(req.toTime);
  if (fromMin === null) {
    issues.push(err("fromTime", `Time From must be HH:MM 24-hour, got "${req.fromTime}".`));
  }
  if (toMin === null) {
    issues.push(err("toTime", `Time To must be HH:MM 24-hour, got "${req.toTime}".`));
  }

  // Ordering, which differs between a same-day and a multi-day leave.
  if (ISO_DATE.test(req.leaveFromDate) && ISO_DATE.test(req.leaveToDate)) {
    if (req.leaveToDate < req.leaveFromDate) {
      issues.push(
        err(
          "leaveToDate",
          `To date ${req.leaveToDate} is before From date ${req.leaveFromDate}.`,
        ),
      );
    } else if (req.leaveToDate === req.leaveFromDate && fromMin !== null && toMin !== null) {
      if (toMin < fromMin) {
        issues.push(
          err(
            "toTime",
            `On ${req.leaveFromDate}, Time To ${req.toTime} is before Time From ${req.fromTime}.`,
          ),
        );
      } else if (toMin === fromMin) {
        issues.push(
          err("toTime", "Time From and Time To are the same instant on a single-day leave."),
        );
      }
    }
  }

  // The 6 PM rule: DAY OUTING only, 18:00 itself allowed.
  let blockedByDayOutingRule = false;
  if (req.leaveCode === "OG1" && toMin !== null) {
    const latest = minutesOfDay("18:00");
    if (latest !== null && toMin > latest) {
      blockedByDayOutingRule = true;
      issues.push(
        err(
          "toTime",
          `A DAY OUTING must be back by 18:00; ${req.toTime} is later. ` +
            "This is a hard rule for day outings — pick another return time, or " +
            "apply as a different leave type.",
        ),
      );
    }
  } else if (
    req.leaveCode !== "OG1" &&
    toMin !== null &&
    toMin > minutesOfDay("18:00")!
  ) {
    // Not an error for other types, but worth saying out loud: the student
    // confirmed this rule applies to DAY OUTING only.
    issues.push(
      warn(
        "toTime",
        `Returning at ${req.toTime} is after 18:00. That is permitted for ` +
          `${req.leaveCode} — the 6 PM deadline applies to DAY OUTING only — ` +
          "but a proctor may still query it.",
      ),
    );
  }

  const duration = durationDaysInclusive(req.leaveFromDate, req.leaveToDate);

  // Duration caps. Only HT1 has a cap we have actually seen enforced, so only
  // HT1 is checked. Types with no known cap get an advisory rather than a
  // verdict, because "we don't know the limit" must never read as "no limit".
  if (duration !== null) {
    const cap = LEAVE_MAX_DAYS[req.leaveCode as keyof typeof LEAVE_MAX_DAYS];
    if (cap !== undefined && duration > cap) {
      issues.push(
        err(
          "leaveToDate",
          `A ${req.leaveCode} leave may not exceed ${cap} days; this one is ${duration}. ` +
            "VTOP rejects longer requests (it returns 'Hometown duration should not " +
            `exceed ${cap} days'). Either shorten it to ${cap} days or apply under a ` +
            "type with a longer allowance.",
        ),
      );
    } else if (
      cap === undefined &&
      duration > 14
    ) {
      issues.push(
        warn(
          "leaveToDate",
          `This leave is ${duration} days. No maximum is known for ${req.leaveCode} — ` +
            `VTOP enforces its own limits server-side and publishes none of them, and ` +
            `only HOME TOWN's ${LEAVE_MAX_DAYS.HT1}-day cap has been observed. If VTOP ` +
            "rejects it, nothing is created and you can retry under another type.",
        ),
      );
    }
  }

  return {
    valid: !issues.some((i) => i.severity === "error"),
    issues,
    durationDays: duration,
    blockedByDayOutingRule,
  };
}

// --- confirmation tokens ---------------------------------------------------

/**
 * A stable fingerprint of a leave request.
 *
 * The two-step apply exists so nothing reaches the proctor unseen. The confirm
 * step must therefore prove it is confirming *the request that was previewed* —
 * a fingerprint binds the confirmation to the exact field values, so a changed
 * date, time or reason invalidates a token instead of silently submitting
 * something the user never saw.
 *
 * Excludes nothing: every submitted field is included on purpose.
 */
export function leaveFingerprint(req: LeaveRequest): string {
  const canonical = [
    req.leaveCode.trim().toUpperCase(),
    req.visitingPlace.trim(),
    req.leaveFromDate.trim(),
    req.fromTime.trim(),
    req.leaveToDate.trim(),
    req.toTime.trim(),
    req.reason.trim(),
  ].join("\u0000");
  // FNV-1a: short, dependency-free, and enough to catch an accidental or
  // casual edit between preview and confirm. This is an integrity check
  // against mistakes, not a security control.
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Server-signed single-use preview tokens (issue #6).
 *
 * The raw fingerprint above is client-computable, so it cannot prove the user
 * saw the preview. These tokens bind a SHA-256 digest of the exact field
 * values with an HMAC keyed by CONNECTOR_SECRET in multi-user mode (or an
 * ephemeral process key in single-user stdio mode), plus a nonce, expiry,
 * and single-use tracking. The FNV fingerprint stays for display only — the
 * MAC binds the full field digest, so grinding a 32-bit collision gains
 * nothing.
 */
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_PREVIEW_NONCES = 10000;
const usedPreviewNonces = new Map<string, number>();
let ephemeralPreviewKey: Buffer | null = null;

/** Exact field values the token binds, in a stable order. */
function canonicalLeave(req: LeaveRequest): string {
  return [
    req.leaveCode.trim().toUpperCase(),
    req.visitingPlace.trim(),
    req.leaveFromDate.trim(),
    req.fromTime.trim(),
    req.leaveToDate.trim(),
    req.toTime.trim(),
    req.reason.trim(),
  ].join("\u0000");
}

/** SHA-256 digest of the bound fields — collision-grinding is infeasible. */
function fieldDigest(req: LeaveRequest): string {
  return createHash("sha256").update(canonicalLeave(req), "utf8").digest("hex");
}

function previewKey(): Buffer {
  const secret = process.env.CONNECTOR_SECRET;
  if (secret && secret.length >= 16) {
    // Key separation from credential tokens: different purpose string.
    return createHmac("sha256", secret).update("vtop-mcp-preview-v1").digest();
  }
  if (!ephemeralPreviewKey) ephemeralPreviewKey = randomBytes(32);
  return ephemeralPreviewKey;
}

function sweepPreviewNonces(now: number): void {
  for (const [k, exp] of usedPreviewNonces) {
    if (exp <= now) usedPreviewNonces.delete(k);
    if (usedPreviewNonces.size === 0) return;
  }
  // Cap growth within the TTL window: evict oldest-first past the cap.
  // Inserts only happen on successful verifies (each costing a real submit),
  // so reaching the cap means abnormal burst traffic, not normal use.
  if (usedPreviewNonces.size >= MAX_PREVIEW_NONCES) {
    for (const [k] of usedPreviewNonces) {
      usedPreviewNonces.delete(k);
      if (usedPreviewNonces.size < MAX_PREVIEW_NONCES) break;
    }
  }
}

/** Issue a single-use expiring token binding an opaque digest and caller. */
function issueSignedToken(digest: string, callerKey: string): string {
  const nonce = randomBytes(16).toString("hex");
  const exp = Date.now() + PREVIEW_TTL_MS;
  const mac = createHmac("sha256", previewKey())
    .update(`${nonce}.${exp}.${callerKey}.${digest}`)
    .digest("base64url");
  return `${nonce}.${exp}.${mac}`;
}

/** Verify a token issued by issueSignedToken. Messages stay identical across
 *  handshake kinds so callers and tests pin one vocabulary. */
function verifySignedToken(
  digest: string,
  token: string,
  callerKey: string,
): { ok: true } | { ok: false; reason: string } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "unrecognised preview token — preview again for a fresh one" };
  }
  const [nonce, expStr, mac] = parts as [string, string, string];
  const exp = Number(expStr);
  if (!/^[0-9a-f]{32}$/.test(nonce) || !Number.isFinite(exp)) {
    return { ok: false, reason: "unrecognised preview token — preview again for a fresh one" };
  }
  const now = Date.now();
  sweepPreviewNonces(now);
  if (now > exp) return { ok: false, reason: "preview token expired — preview again" };
  if (usedPreviewNonces.has(nonce)) {
    return { ok: false, reason: "preview token already used — preview again for a fresh one" };
  }
  const expected = createHmac("sha256", previewKey())
    .update(`${nonce}.${exp}.${callerKey}.${digest}`)
    .digest("base64url");
  const a = Buffer.from(mac, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "preview token does not match these field values — nothing submitted, preview again" };
  }
  usedPreviewNonces.set(nonce, exp);
  return { ok: true };
}

/** Issue a single-use expiring token binding this exact request and caller. */
export function issuePreviewToken(req: LeaveRequest, callerKey: string): string {
  return issueSignedToken(fieldDigest(req), callerKey);
}

/** Verify a preview token against the request it must confirm. Null = reject. */
export function verifyPreviewToken(
  req: LeaveRequest,
  token: string,
  callerKey: string,
): { ok: true } | { ok: false; reason: string } {
  return verifySignedToken(fieldDigest(req), token, callerKey);
}

/** Digest binding a leave-cancellation handshake to one leave id. Scoped with
 *  a "cancel" domain separator so an apply token can never verify as a cancel
 *  token and vice versa. */
function cancelDigest(leaveId: string): string {
  return createHash("sha256").update(`cancel\u0000${leaveId.trim().toUpperCase()}`, "utf8").digest("hex");
}

/** Issue a single-use expiring token binding this leave cancellation. */
export function issueCancelToken(leaveId: string, callerKey: string): string {
  return issueSignedToken(cancelDigest(leaveId), callerKey);
}

/** Verify a cancel token against the leave id it must cancel. */
export function verifyCancelToken(
  leaveId: string,
  token: string,
  callerKey: string,
): { ok: true } | { ok: false; reason: string } {
  return verifySignedToken(cancelDigest(leaveId), token, callerKey);
}

// --- exam parsing and overlap ----------------------------------------------

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/** VTOP prints exam dates as "30-OCT-2026". Returns ISO, or null. */
export function normaliseExamDate(raw: string): string | null {
  // Anchored: the old unanchored pattern matched substrings ("130-OCT-20261").
  const m = /^(\d{1,2})-([A-Z]{3})-(\d{4})$/i.exec((raw ?? "").trim());
  if (!m) return null;
  const month = MONTHS[m[2].toUpperCase()];
  const day = Number(m[1]);
  if (month === undefined || day < 1 || day > 31) return null;
  return `${m[4] ?? m[3]}-${String(month + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/** Parse a printed clock time ("01:15 PM") to minutes since midnight. */
export function examClockToMinutes(token: string): number | null {
  const m = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(token.trim());
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  if (minute > 59) return null;
  if (m[3].toUpperCase() === "P") hour = hour === 12 ? 12 : hour + 12;
  else hour = hour === 12 ? 0 : hour;
  if (hour > 23) return null;
  return hour * 60 + minute;
}

export interface ExamWindow {
  examType: string;
  courseCode: string;
  courseName: string;
  /** ISO date, or null when VTOP printed none. */
  date: string | null;
  /** Raw printed time, e.g. "01:15 PM - 04:15 PM". */
  time: string;
  startMin: number | null;
  endMin: number | null;
}

export interface ExamLike {
  examType: string;
  courseCode: string;
  courseName: string;
  examDate: string;
  time: string;
}

/** Parse an exam row into a comparable window. */
export function parseExamWindow(e: ExamLike): ExamWindow {
  const parts = (e.time ?? "").split(/\s*-\s*/);
  return {
    examType: e.examType,
    courseCode: e.courseCode,
    courseName: e.courseName,
    date: normaliseExamDate(e.examDate),
    time: e.time ?? "",
    startMin: parts[0] ? examClockToMinutes(parts[0]) : null,
    endMin: parts[1] ? examClockToMinutes(parts[1]) : null,
  };
}

export type ExamVerdict =
  /** The whole exam falls inside the leave — it would be missed. */
  | "CONFLICT"
  /** The exam finishes before departure, or starts after return. */
  | "CLEAR"
  /** Overlaps, but VTOP gave no usable time so it cannot be cleared. */
  | "UNKNOWN";

export interface ExamOverlap {
  exam: ExamWindow;
  verdict: ExamVerdict;
  /** Minutes between the exam ending and departure (or return to start). */
  gapMinutes: number | null;
  explanation: string;
}

export interface ExamOverlapResult {
  /** Exams that fall on a date inside the leave window. */
  checked: ExamOverlap[];
  /** Of those, the ones that would actually be missed. */
  conflicts: ExamOverlap[];
  cleared: ExamOverlap[];
  unknown: ExamOverlap[];
  /** True when the exam schedule could not be read at all. */
  scheduleUnavailable: boolean;
  note: string | null;
}

/**
 * Which exams a leave window would swallow.
 *
 * The distinction that matters is not "does an exam share a date with my leave"
 * but "does it clash with the hours I am actually away". A leave that starts at
 * 17:00 does not cost you a 13:15-16:15 paper; one that starts at 08:00 does.
 *
 * Time-less exams (VTOP publishes CAT rows with no date or time) fall back to
 * UNKNOWN rather than CLEAR: silence from VTOP is not permission to assume you
 * are free.
 */
export function findExamOverlaps(
  leave: { fromDate: string; fromTime: string; toDate: string; toTime: string },
  exams: ExamLike[],
): ExamOverlapResult {
  const leaveFrom = minutesOfDay(leave.fromTime) ?? 0;
  const leaveTo = minutesOfDay(leave.toTime) ?? 24 * 60;

  const checked: ExamOverlap[] = [];
  for (const e of exams) {
    const w = parseExamWindow(e);
    if (!w.date) continue; // CAT rows with no published date are out of scope
    if (w.date < leave.fromDate || w.date > leave.toDate) continue;

    const sameDayAsStart = w.date === leave.fromDate;
    const sameDayAsEnd = w.date === leave.toDate;
    const singleDayLeave = leave.fromDate === leave.toDate;

    let verdict: ExamVerdict;
    let gap: number | null = null;
    let explanation: string;

    if (w.startMin === null || w.endMin === null) {
      verdict = "UNKNOWN";
      explanation =
        `${w.examType} on ${w.date} falls inside this leave and VTOP published no ` +
        "time for it, so it cannot be confirmed as clear. Check the timetable.";
    } else if (sameDayAsStart && singleDayLeave && w.endMin <= leaveFrom) {
      verdict = "CLEAR";
      gap = leaveFrom - w.endMin;
      explanation =
        `${w.examType} ends ${hhmm(w.endMin)} and you depart ${hhmm(leaveFrom)} — ` +
        `clear by ${gap} minutes.`;
    } else if (sameDayAsEnd && singleDayLeave && w.startMin >= leaveTo) {
      verdict = "CLEAR";
      gap = w.startMin - leaveTo;
      explanation =
        `${w.examType} starts ${hhmm(w.startMin)} and you return ${hhmm(leaveTo)} — ` +
        `clear by ${gap} minutes.`;
    } else if (sameDayAsStart && !singleDayLeave && w.endMin <= leaveFrom) {
      verdict = "CLEAR";
      gap = leaveFrom - w.endMin;
      explanation =
        `${w.examType} ends ${hhmm(w.endMin)} and you depart ${hhmm(leaveFrom)} — ` +
        `clear by ${gap} minutes.`;
    } else if (sameDayAsEnd && !singleDayLeave && w.startMin >= leaveTo) {
      verdict = "CLEAR";
      gap = w.startMin - leaveTo;
      explanation =
        `${w.examType} starts ${hhmm(w.startMin)} and you return ${hhmm(leaveTo)} — ` +
        `clear by ${gap} minutes.`;
    } else if (
      (!sameDayAsStart && !sameDayAsEnd) ||
      (sameDayAsStart && sameDayAsEnd && singleDayLeave)
    ) {
      // Interior day of a multi-day leave, or a whole single day: unavoidable.
      verdict = "CONFLICT";
      explanation =
        `${w.examType} (${hhmm(w.startMin)}-${hhmm(w.endMin)}) is entirely inside ` +
        "this leave. You would miss it, and there is no re-test.";
    } else {
      verdict = "CONFLICT";
      explanation =
        `${w.examType} (${hhmm(w.startMin)}-${hhmm(w.endMin)}) overlaps the hours ` +
        `you are away (${hhmm(leaveFrom)}-${hhmm(leaveTo)}). You would miss it, and ` +
        "there is no re-test.";
    }

    checked.push({ exam: w, verdict, gapMinutes: gap, explanation });
  }

  return {
    checked,
    conflicts: checked.filter((c) => c.verdict === "CONFLICT"),
    cleared: checked.filter((c) => c.verdict === "CLEAR"),
    unknown: checked.filter((c) => c.verdict === "UNKNOWN"),
    scheduleUnavailable: false,
    note:
      "Exams are compared against the HOURS you are away, not just the dates, so " +
      "a leave that begins after a paper ends is reported as clear rather than " +
      "flagged. A FAT or CAT missed here cannot be resat.",
  };
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// --- class-overlap detection -----------------------------------------------

export interface OverlapClass {
  date: string;
  courseCode: string;
  courseName: string;
  startTime: string;
  endTime: string;
  venue: string;
}

export interface OverlapResult {
  /** Classes falling inside the leave window that would be missed. */
  missed: OverlapClass[];
  /** How many distinct days carry at least one missed class. */
  affectedDays: number;
  /** Per-course missed-session counts, worst first. */
  byCourse: { courseCode: string; courseName: string; missed: number }[];
  /**
   * True when a class outside the leave window falls on the same calendar day
   * (e.g. a morning class before a 14:00 departure) — the leave covers the day
   * on paper but the timetable does not.
   */
  partialDays: string[];
}

const minutesOf = (hhmm: string): number => minutesOfDay(hhmm) ?? 0;

/**
 * Which scheduled classes a leave window would swallow.
 *
 * A class is missed when its day is inside the leave range and either the leave
 * spans the whole day or the class is not entirely before the departure time.
 */
export function findClassOverlaps(
  leave: { fromDate: string; fromTime: string; toDate: string; toTime: string },
  sessions: { date: string; courseCode: string; courseName: string; startTime: string; endTime: string; venue: string }[],
): OverlapResult {
  const missed: OverlapClass[] = [];
  const dayHasMissed = new Set<string>();
  const dayHasPartial = new Set<string>();
  const perCourse = new Map<string, { courseCode: string; courseName: string; missed: number }>();

  for (const s of sessions) {
    if (s.date < leave.fromDate || s.date > leave.toDate) continue;

    const startsOnFirstDay = s.date === leave.fromDate;
    const endsOnLastDay = s.date === leave.toDate;

    // For a multi-day leave, every interior day is lost entirely. Boundary
    // days keep partial-day filtering: a class before departure or after
    // return is not missed.
    const wholeDay = !startsOnFirstDay && !endsOnLastDay;
    const classEnd = minutesOf(s.endTime);
    const classStart = minutesOf(s.startTime);

    const outsideWindow =
      startsOnFirstDay && !wholeDay && classEnd <= minutesOf(leave.fromTime);
    const afterReturn =
      endsOnLastDay && !wholeDay && classStart >= minutesOf(leave.toTime);

    if (outsideWindow || afterReturn) {
      // A day can hold both missed and outside-window classes: record the
      // partial day unconditionally so the output never depends on input row
      // order.
      dayHasPartial.add(s.date);
      continue;
    }

    missed.push({ ...s });
    dayHasMissed.add(s.date);
    const entry = perCourse.get(s.courseCode) ?? {
      courseCode: s.courseCode,
      courseName: s.courseName,
      missed: 0,
    };
    entry.missed++;
    perCourse.set(s.courseCode, entry);
  }

  const byCourse = [...perCourse.values()].sort((a, b) => b.missed - a.missed);
  return {
    missed: missed.sort((a, b) =>
      a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date),
    ),
    affectedDays: dayHasMissed.size,
    byCourse,
    partialDays: [...dayHasPartial].sort(),
  };
}


/**
 * Withdraw POST body for a requestDataListUpdate Cancel button - the TABLE
 * branch of the leave-status page's own JS (hostels/student/leave/4). Every
 * field mirrors what the browser sends, byte for byte:
 * - controlName + its live #id value (jQuery .val() on a missing element is
 *   undefined, which string-concats to the literal 'undefined' - reproduced
 *   here rather than 'fixed', since VTOP accepts exactly that).
 * - form is the button's data-formname, or the literal 'undefined' the page
 *   produces when the attribute is absent (same literal this codebase already
 *   sends for the leave form).
 * - one field per data-parameters entry, read from #name{rowNumber}.
 * Throws instead of guessing when the wiring is incomplete: a wrong field
 * here would withdraw nothing while reporting success, or error opaquely.
 */
export interface LeaveWithdrawWiring {
  controlName: string;
  urlText: string;
  rowParams: Record<string, string>;
  cancelButtonValue: string | null;
  formName: string | null;
}

export function buildLeaveWithdrawBody(w: LeaveWithdrawWiring): {
  endpoint: string;
  body: Record<string, string>;
} {
  if (!w.controlName || !w.urlText) {
    throw new Error(
      "Withdraw control is missing its wiring (controlname/urltext). " +
        "Refusing to guess the withdraw POST - report this shape.",
    );
  }
  if (!w.urlText.startsWith("hostels/student/leave/")) {
    throw new Error(
      "Withdraw target '" +
        w.urlText +
        "' is outside the leave module. " +
        "Refusing to post somewhere the page never sends withdraws.",
    );
  }
  if (Object.keys(w.rowParams).length === 0) {
    throw new Error(
      "Withdraw control carries no row parameters (e.g. leaveId). " +
        "Refusing to post a withdraw with no leave reference.",
    );
  }
  return {
    endpoint: w.urlText,
    body: {
      [w.controlName]: w.cancelButtonValue ?? "undefined",
      form: w.formName ?? "undefined",
      control: w.controlName,
      ...w.rowParams,
      x: new Date().toUTCString(),
    },
  };
}
