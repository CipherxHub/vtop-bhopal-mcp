import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VtopClient } from "../services/vtop-client.js";
import {
  parseExamSchedule,
  parseLeaveRecords,
  parseLeaveTypeOptions,
  parseTimetableGrid,
} from "../services/vtop-parser.js";
import {
  DAY_OUTING_CODE,
  DAY_OUTING_LATEST_RETURN,
  LEAVE_MAX_DAYS,
  LEAVE_TYPES,
} from "../services/constants.js";
import {
  findClassOverlaps,
  findExamOverlaps,
  leaveFingerprint,
  normaliseTime,
  validateLeave,
  type ExamOverlapResult,
  type LeaveRequest,
} from "../services/leave.js";
import { ApplyLeaveSchema } from "../schemas/index.js";
import { mkJsonTool } from "./_helpers.js";

/** Today in IST, matching the rest of the tools. */
function istToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Resolve the actual classes on each calendar date in a window.
 *
 * Deliberately best-effort: the overlap check is a warning about your own
 * timetable, not a VTOP fact. If the calendar or grid cannot be read we say so
 * and carry on, rather than blocking a leave application on an unrelated fetch.
 */
async function classesInWindow(
  client: VtopClient,
  semesterId: string,
  fromDate: string,
  toDate: string,
): Promise<{
  sessions: { date: string; courseCode: string; courseName: string; startTime: string; endTime: string; venue: string }[];
  warning: string | null;
}> {
  const warning: string[] = [];
  try {
    const calendar = await client.getCalendar(semesterId, fromDate, toDate);
    const instructional = new Set(
      calendar.filter((d) => d.instructional).map((d) => d.date),
    );
    const grid = parseTimetableGrid(await client.getTimetableHtml(semesterId));
    const gridSessions = grid;

    const sessions: {
      date: string; courseCode: string; courseName: string;
      startTime: string; endTime: string; venue: string;
    }[] = [];
    for (const day of instructional) {
      const weekday = weekdayOf(day);
      for (const s of gridSessions) {
        if (s.day !== weekday) continue;
        sessions.push({
          date: day,
          courseCode: s.courseCode,
          courseName: "",
          startTime: s.startTime,
          endTime: s.endTime,
          venue: s.venue,
        });
      }
    }
    if (instructional.size === 0) {
      warning.push(
        "The academic calendar listed no instructional days in this window, so no " +
          "classes could be counted. The overlap check is INCOMPLETE.",
      );
    }
    return { sessions, warning: warning.join(" ") || null };
  } catch (err) {
    return {
      sessions: [],
      warning:
        `Could not read the timetable or calendar (${err instanceof Error ? err.message : String(err)}). ` +
        "The class-overlap check was SKIPPED — review your own schedule before submitting.",
    };
  }
}

function weekdayOf(iso: string): string {
  const names = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return names[d] ?? "";
}

export function registerLeaveTools(server: McpServer, client: VtopClient): void {
  // --- diagnostic: per-type constraints, read without submitting -----------
  mkJsonTool(
    server,
    "get_leave_type_rules",
    "Diagnostic: ask VTOP what rules apply to each hostel leave type (max days, " +
      "limits, required fields) by triggering the same request the leave-type " +
      "dropdown makes when you change the selection.\n" +
      "READ-ONLY - this never submits a leave application. It exists because the " +
      "day limits are server-side rules that are otherwise only discoverable by " +
      "submitting and being rejected (e.g. HOME TURN caps at 14 days).\n" +
      "Omit leaveCode to probe every type. Returns the raw text VTOP replies " +
      "with for each, so limits can be read directly rather than guessed.",
    {
      leaveCode: z
        .string()
        .optional()
        .describe("A single code to probe (SO, WP, EP, SV, WV, HT1, LG1, EY1, OG1). Omit for all."),
    },
    async ({ leaveCode }) => {
      const all = parseLeaveTypeOptions(await client.getLeaveFormHtml());
      const codes = leaveCode ? [leaveCode] : all.map((o) => o.code);
      const results: {
        code: string;
        label: string;
        message: string | null;
        rules: string[];
        raw: string;
      }[] = [];

      for (const code of codes) {
        const html = await client.getLeaveTypeConstraints(code);
        const text = cheerioText(html);
        // Pull anything that looks like a stated limit.
        const rules = [
          ...new Set(
            [...text.matchAll(/[^.]*\b(?:\d+\s*days?|maximum|max|limit|not exceed|should not|only)\b[^.]*\./gi)]
              .map((m) => m[0].trim())
              .filter((s) => s.length > 8 && s.length < 400),
          ),
        ].slice(0, 12);
        results.push({
          code,
          label: all.find((o) => o.code === code)?.label ?? code,
          message: extractMessage(html),
          rules,
          raw: text.length > 1200 ? text.slice(0, 1200) + " …[truncated]" : text,
        });
      }

      return {
        probed: results.length,
        note:
          "These are VTOP's own replies to the dropdown's onchange request. Where " +
          "`rules` is empty, VTOP publishes no limit for that type and the only way " +
          "to learn one is to submit and be rejected - which is safe, because a " +
          "rejected submission creates nothing.",
        results,
      };
    },
    { emptyMessage: "No leave types published by VTOP." },
  );
  // --- read: leave types ---------------------------------------------------
  mkJsonTool(
    server,
    "get_leave_types",
    "List the hostel leave types VTOP currently offers, read from the live leave form " +
      "(so a newly added or retired type is reflected rather than assumed). Use the CODE, " +
      "not the label. Also states the 6 PM in-time rule: it applies to OG1 (Day Outing) only, " +
      "and 18:00 itself is allowed. Requires login.",
    {},
    async () => {
      const options = parseLeaveTypeOptions(await client.getLeaveFormHtml());
      return {
        types: options,
        dayOutingRule: {
          appliesTo: DAY_OUTING_CODE,
          latestReturn: DAY_OUTING_LATEST_RETURN,
          note:
            "A DAY OUTING must be back by 18:00; 18:00 is allowed, 18:01 is refused. " +
            "This does NOT apply to other leave types - a Special Outing may return later.",
        },
      };
    },
  );

  // --- read: leave status --------------------------------------------------
  mkJsonTool(
    server,
    "get_leave_status",
    "Get hostel leave applications and their approval status: leave id, type, place, " +
      "from/to, status (REQUEST APPROVED / HOSTEL APPROVAL PENDING / etc.), approver " +
      "remarks, and gate-pass OUT/IN flags where VTOP publishes them. " +
      "Read-only. Requires login.",
    {},
    async () => {
      const records = parseLeaveRecords(await client.getLeaveStatusHtml());
      return {
        count: records.length,
        records,
        note:
          "Statuses are reported exactly as VTOP prints them. An empty list means VTOP " +
          "has no leave records to show, which is different from the module being " +
          "unavailable - that raises ENDPOINT_NOT_FOUND instead.",
      };
    },
    { emptyMessage: "No leave applications found on VTOP." },
  );

  // --- write: apply leave --------------------------------------------------
  mkJsonTool(
    server,
    "apply_leave",
    "Apply for hostel leave on VTOP. THIS WRITES TO VTOP and creates a real request " +
      "for your proctor, so it is deliberately two-step.\n" +
      "  Call 1 (preview): pass the details with confirm OMITTED or false. Nothing is " +
      "sent. You get back the normalised values, every rule that fired, any classes the " +
      "leave would make you miss, and a previewToken.\n" +
      "  Call 2 (submit): repeat the SAME details plus confirm=true and the previewToken. " +
      "The token is a fingerprint of the exact field values, so if anything changed since " +
      "the preview the submission is refused and you must preview again.\n" +
      "Always show the user the preview and get their agreement before calling with " +
      "confirm=true. Never invent a previewToken or set confirm=true on a first call.\n" +
      "Rules enforced before submitting: OG1 (Day Outing) must return by 18:00 inclusive; " +
      "dates must be ISO YYYY-MM-DD and not in the past; to-date cannot precede " +
      "from-date; visiting place is required and capped at 150 characters; reason is required. " +
      "Times are normalised, so '6:00 PM' becomes '18:00'.\n" +
      "Requires login.",
    ApplyLeaveSchema.shape,
    async ({ confirm, previewToken, ...raw }) => {
      const today = istToday();

      // Normalise before anything else: the fingerprint and the validation must
      // both see the SAME values, or a preview could confirm a different request
      // from the one that gets submitted.
      const fromTime = normaliseTime(raw.fromTime);
      const toTime = normaliseTime(raw.toTime);
      if (fromTime === null) {
        throw new Error(`Time From "${raw.fromTime}" is not a time I can read. Use 18:00 or 6:00 PM.`);
      }
      if (toTime === null) {
        throw new Error(`Time To "${raw.toTime}" is not a time I can read. Use 18:00 or 6:00 PM.`);
      }

      const request: LeaveRequest = {
        leaveCode: raw.leaveCode.trim().toUpperCase(),
        visitingPlace: raw.visitingPlace.trim(),
        leaveFromDate: raw.leaveFromDate.trim(),
        fromTime,
        leaveToDate: raw.leaveToDate.trim(),
        toTime,
        reason: raw.reason.trim(),
      };

      // Leave types come from the live form so an invented code is caught here.
      let knownTypes: string[];
      try {
        knownTypes = parseLeaveTypeOptions(await client.getLeaveFormHtml()).map((o) => o.code);
      } catch {
        knownTypes = LEAVE_TYPES.map((t) => t.code);
      }

      const validation = validateLeave(request, { todayISO: today, knownTypes });
      const fingerprint = leaveFingerprint(request);

      const semesterId = await client.getCurrentSemesterId();
      const overlap = validation.durationDays
        ? await classesInWindow(client, semesterId, request.leaveFromDate, request.leaveToDate)
        : { sessions: [], warning: null };
      const classes = validation.durationDays
        ? findClassOverlaps(
            {
              fromDate: request.leaveFromDate,
              fromTime: request.fromTime,
              toDate: request.leaveToDate,
              toTime: request.toTime,
            },
            overlap.sessions,
          )
        : null;

      // Exams, not just classes. A leave that swallows a FAT or CAT is far more
      // serious than one that misses a lecture, and there is no re-test — so
      // this is checked against the hours you are actually away.
      let exams: ExamOverlapResult = {
        checked: [], conflicts: [], cleared: [], unknown: [],
        scheduleUnavailable: true, note: null,
      };
      if (validation.durationDays) {
        try {
          const schedule = parseExamSchedule(
            await client.getExamScheduleHtml(semesterId),
          );
          exams = findExamOverlaps(
            {
              fromDate: request.leaveFromDate,
              fromTime: request.fromTime,
              toDate: request.leaveToDate,
              toTime: request.toTime,
            },
            schedule,
          );
        } catch (err) {
          exams = {
            ...exams,
            note:
              `Could not read the exam schedule (${err instanceof Error ? err.message : String(err)}). ` +
              "Exams were NOT checked against this leave — verify them yourself.",
          };
        }
      }

      const label =
        LEAVE_TYPES.find((t) => t.code === request.leaveCode)?.label ?? request.leaveCode;

      const preview = {
        mode: "PREVIEW - nothing has been submitted",
        request: { ...request, leaveTypeLabel: label },
        normalised: {
          note: "Times were normalised to 24-hour HH:MM before validation.",
          fromTime,
          toTime,
        },
        validation,
        durationDays: validation.durationDays,
        durationLimits: {
          known: { ...LEAVE_MAX_DAYS },
          note:
            "VTOP enforces per-type day limits server-side and publishes none of " +
            "them; these are the ones actually observed. A type absent from `known` " +
            "means the limit is UNKNOWN, not unlimited - VTOP may still refuse it, " +
            "and a refusal creates nothing.",
        },
        classOverlap: classes
          ? { ...classes, warning: overlap.warning, checkedAgainst: "timetable + academic calendar" }
          : { warning: "Leave is not valid yet, so no overlap check was run." },
        examOverlap: {
          ...exams,
          checkedCount: exams.checked.length,
          conflictCount: exams.conflicts.length,
          summary:
            exams.scheduleUnavailable
              ? "NOT CHECKED — exam schedule unavailable"
              : exams.conflicts.length
                ? `${exams.conflicts.length} exam(s) would be MISSED`
                : exams.checked.length
                  ? `No clash - ${exams.cleared.length} exam(s) fall inside the leave dates but not your hours away`
                  : "No exams fall inside this leave",
        },
        previewToken: fingerprint,
        nextStep:
          "Show this to the user. If they agree, call apply_leave again with the IDENTICAL " +
          "fields plus confirm=true and previewToken=" + fingerprint + ".",
      };

      // --- preview path: never writes ---
      if (confirm !== true) {
        if (!validation.valid) {
          return {
            ...preview,
            mode: "PREVIEW - REJECTED, nothing submitted",
            verdict:
              "This leave cannot be submitted. Fix the errors above and preview again.",
          };
        }
        return preview;
      }

      // --- confirm path: writes ---
      if (!previewToken) {
        return {
          ...preview,
          mode: "CONFIRM REJECTED - nothing submitted",
          verdict:
            "confirm=true needs the previewToken from a preview call. Run apply_leave " +
            "without confirm first.",
        };
      }
      if (previewToken !== fingerprint) {
        return {
          ...preview,
          mode: "CONFIRM REJECTED - nothing submitted",
          verdict:
            "The previewToken does not match these field values, so something changed " +
            "since the preview. Nothing was submitted - preview again and confirm the " +
            "exact request you were shown.",
        };
      }
      if (!validation.valid) {
        return {
          ...preview,
          mode: "CONFIRM REJECTED - nothing submitted",
          verdict: "Validation failed, so nothing was submitted.",
        };
      }

      const responseHtml = await client.submitLeaveApplication({
        leaveCode: request.leaveCode,
        visitingPlace: request.visitingPlace,
        leaveFromDate: request.leaveFromDate,
        fromTime: request.fromTime,
        leaveToDate: request.leaveToDate,
        toTime: request.toTime,
        reason: request.reason,
      });

      const applied = parseLeaveRecords(responseHtml);
      const vtopMessage = extractMessage(responseHtml);
      // VTOP rejects bad submits server-side (e.g. over a duration cap) by
      // returning the form/error page with no new leave row. Never report
      // success when nothing was created.
      if (
        applied.length === 0 &&
        /not exceed|reject|fail|error|unable|cannot|invalid/i.test(vtopMessage ?? "")
      ) {
        return {
          mode: "SUBMIT REJECTED - nothing created",
          submitted: request,
          submittedAt: new Date().toISOString(),
          vtopResponse: {
            leaveRecords: applied,
            message: vtopMessage,
          },
          verdict:
            vtopMessage ??
            "VTOP did not create a leave — no new record was returned. Nothing was submitted.",
        };
      }
      return {
        mode: "SUBMITTED",
        submitted: request,
        submittedAt: new Date().toISOString(),
        vtopResponse: {
          leaveRecords: applied,
          message: vtopMessage,
        },
        nextStep:
          "Call get_leave_status to see the approval state. A leave is not approved until " +
          "the proctor acts - REQUEST APPROVED and HOSTEL APPROVAL PENDING are different states.",
      };
    },
    {
      // This tool WRITES. readOnlyHint=false is what makes an MCP client raise
      // a permission prompt instead of auto-approving a leave application.
      hints: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
  );
}

/** Visible text of an HTML fragment, for surfacing VTOP's own messages. */
function cheerioText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pull VTOP's own confirmation text out of the submit response. */
function extractMessage(html: string): string | null {
  const m =
    /id="pageMessage"[^>]*>([\s\S]{0,400}?)<\//i.exec(html) ??
    /id="messageText"[^>]*>([\s\S]{0,400}?)<\//i.exec(html);
  const text = m?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text && text.length > 0 ? text : null;
}

// Re-exported so the tests can reach the helpers without another import path.
export { istToday, weekdayOf };