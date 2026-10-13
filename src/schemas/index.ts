import { z } from "zod";

export const LoginSchema = z.object({
  username: z
    .string()
    .optional()
    .describe(
      "VTOP username / registration number. Optional — if the MCP server has VTOP_USERNAME set as an env var, omit this and the server will use the stored value. Do not ask the user for credentials if they're already configured."
    ),
  password: z
    .string()
    .optional()
    .describe(
      "VTOP password. Optional — if the MCP server has VTOP_PASSWORD set as an env var, omit this and the server will use the stored value. Do not ask the user for credentials if they're already configured."
    ),
  captcha: z
    .string()
    .describe("Captcha solution from the get_captcha tool"),
});

export const SemesterInputSchema = z.object({
  semesterId: z
    .string()
    .optional()
    .describe(
      "Semester ID (e.g. 'AP2024251'). If omitted, uses the current/latest semester."
    ),
  refresh: z
    .boolean()
    .optional()
    .describe(
      "Bypass the short cache and re-read the page from VTOP. Results are cached for " +
        "60 seconds so follow-up questions are instant; set this when you specifically " +
        "want to know whether something has just been updated.",
    ),
});

export const EmptySchema = z.object({});

export const CalcAttendanceSchema = z.object({
  semesterId: z
    .string()
    .optional()
    .describe("Semester ID (e.g. 'CH20252605'). If omitted, uses the current semester."),
  courseCode: z
    .string()
    .optional()
    .describe("Limit to one course code (e.g. 'BCSE302L'), matched case-insensitively. Omit for all courses."),
  targetPercent: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Attendance % to target. Default 74 — VIT requires 75% but 74.x rounds up to 75."),
  untilDate: z
    .string()
    .optional()
    .describe(
      "Attendance-closing date as ISO YYYY-MM-DD (e.g. a CAT-2 cutoff). When set, the tool projects every class from today to this date using the timetable grid + academic calendar (working days, holidays, working Saturdays / day-orders). Ask the user for this date if they want a deadline-aware answer.",
    ),
  includeUntilDate: z
    .boolean()
    .optional()
    .describe("Whether classes ON the closing date are counted. Default true."),
  bunkDates: z
    .array(z.string())
    .optional()
    .describe(
      "Dates (ISO YYYY-MM-DD) you plan to SKIP — e.g. today. Requires untilDate. For each course the tool reports whether you'd still be safe by the closing date if you skip exactly these days and attend everything else (`plannedBunk`).",
    ),
});


export const CalendarSchema = z.object({
  semesterId: z
    .string()
    .optional()
    .describe(
      "Semester ID. Omit for current semester. Festivals/holidays appear in the term they fall in (e.g. TechnoVIT is a Fall-term event), so to find a specific event you may need that semester's id — use get_semesters.",
    ),
  month: z.string().optional().describe("Restrict to one month as 'YYYY-MM' (e.g. '2026-01')."),
  query: z
    .string()
    .optional()
    .describe("Case-insensitive search of event/holiday names (e.g. 'technovit', 'pongal')."),
  holidaysOnly: z.boolean().optional().describe("Return only non-instructional (holiday / no-class) days."),
  classGroup: z
    .string()
    .optional()
    .describe(
      "Whose calendar: COMB (combined, the default), ALL (General), FS (Freshers), FT (Fast Track) and programme variants. VTOP publishes the list per semester; anything unrecognised returns whatever VTOP serves for it.",
    ),
});

export const TodayClassesSchema = z.object({
  date: z
    .string()
    .optional()
    .describe("ISO date YYYY-MM-DD to look up. If omitted, uses today (IST)."),
});

export const FeeReceiptsSchema = z.object({
  receiptNo: z
    .string()
    .optional()
    .describe(
      "A receipt number from a previous get_fee_receipts call, to fetch that receipt's detail breakdown instead of the list. Omit for the full list.",
    ),
});

export const ApplyLeaveSchema = z.object({
  leaveCode: z
    .string()
    .describe(
      "Leave type CODE, not the label. SO=Special Outing, WP=With Parent Leave, " +
        "EP=Official Leaves, SV=Summer Vacation, WV=Winter Vacation, HT1=Home Town, " +
        "LG1=Local Guardian, EY1=Emergency Leave, OG1=Day Outing. Use " +
        "get_leave_types if unsure.",
    ),
  visitingPlace: z.string().describe("Where you are going. Max 150 characters."),
  leaveFromDate: z
    .string()
    .describe("Departure date as ISO YYYY-MM-DD. Must not be in the past."),
  fromTime: z
    .string()
    .describe(
      "Departure time. 24-hour HH:MM is safest, but '6:00 PM', '1800' and '8.30' " +
        "are all normalised automatically.",
    ),
  leaveToDate: z.string().describe("Return date as ISO YYYY-MM-DD."),
  toTime: z
    .string()
    .describe(
      "Return time, same format as fromTime. For OG1 (Day Outing) it must be " +
        "18:00 or earlier - 18:00 itself is allowed, 18:01 is refused.",
    ),
  reason: z.string().describe("Reason for the leave. Keep it specific."),
  confirm: z
    .boolean()
    .optional()
    .describe(
      "Leave this unset/false for the first call: nothing is submitted, and you " +
        "get back a preview plus a previewToken. Re-call with confirm=true and " +
        "the SAME fields and token to actually submit. Never set confirm=true on " +
        "the first call.",
    ),
  previewToken: z
    .string()
    .optional()
    .describe(
      "The token returned by the preview call. Required with confirm=true. It is " +
        "checked against these exact field values, so editing any field after " +
        "previewing invalidates it — re-run the preview.",
    ),
});
