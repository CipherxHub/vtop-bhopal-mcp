import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VtopClient } from "../services/vtop-client.js";
import { VtopError } from "../services/errors.js";
import {
  computePendingSubjects,
  parseCurriculumBaskets,
  parseFeeReceiptDetail,
  parseFeeReceipts,
  parseGradeHistory,
} from "../services/vtop-parser.js";
import { EmptySchema, FeeReceiptsSchema } from "../schemas/index.js";
import { mkJsonTool } from "./_helpers.js";

export function registerFeesTools(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "get_fee_receipts",
    "Fee payment receipts: receipt number, date, amount and campus for every payment VTOP has on record. Pass receiptNo (from a previous call) to get that receipt's detail breakdown instead of the list. Amounts are as printed; no currency conversion is applied. Read-only. Requires login.",
    FeeReceiptsSchema.shape,
    async ({ receiptNo }) => {
      if (receiptNo) {
        const detail = parseFeeReceiptDetail(
          receiptNo.trim(),
          await client.getFeeReceiptDetailHtml(receiptNo.trim()),
        );
        // A detail miss parses to a text-only dump. That is a rejection,
        // not a receipt — fail loud instead of returning page text as data.
        const fields = detail.fields;
        const onlyText = Object.keys(fields).length === 1 && "text" in fields;
        if (onlyText || /unable to process|not available|invalid|no record/i.test(fields.text ?? "")) {
          throw new VtopError(
            "UPSTREAM",
            `VTOP did not return a receipt breakdown for "${receiptNo.trim()}".`,
            fields.text?.slice(0, 200) ?? "Empty detail response.",
          );
        }
        return detail;
      }
      const receipts = parseFeeReceipts(await client.getFeeReceiptsHtml());
      const total = receipts.reduce((s, r) => s + r.amount, 0);
      return {
        count: receipts.length,
        totalPaid: Math.round(total * 100) / 100,
        receipts,
        note: "Amounts are as printed by VTOP. Pass any receiptNumber back as receiptNo for its detail breakdown.",
      };
    },
  );
}

export function registerCurriculumBasketTools(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "get_curriculum_baskets",
    "Programme curriculum baskets: every category (Programme Core, Programme Elective, University Core/Electives, …) with its courses — code, title, type, version, L/T/P/J and credits. Each row also carries vtopMarkedCompleted, VTOP's own completion marking, reported verbatim. Use get_pending_subjects when you want completed-vs-left rather than the raw baskets. Read-only. Requires login.",
    EmptySchema.shape,
    async () => {
      const baskets = parseCurriculumBaskets(await client.getCurriculumBasketsHtml());
      // Every student has a curriculum: zero parsed baskets means the layout
      // changed, not an empty degree. Fail loud, never categories:0 success.
      if (baskets.length === 0) {
        throw new VtopError(
          "UPSTREAM",
          "VTOP returned a curriculum page with no recognisable course tables.",
          "The layout may have changed. Not treated as an empty curriculum.",
        );
      }
      return {
        categories: baskets.length,
        courseCount: baskets.reduce((s, b) => s + b.courses.length, 0),
        baskets,
      };
    },
  );

  mkJsonTool(
    server,
    "get_course_basket",
    "Which curriculum basket a course belongs to: pass a course code (e.g. 'CSD3002') or a title fragment (e.g. 'salesforce') and get back every matching catalogue course with its basket (Programme Core, Programme Elective, …), credits and completion state. Works for courses you have never taken — it reads the programme catalogue, not your records. Read-only. Requires login.",
    {
      query: z
        .string()
        .describe("Course code or title fragment to look up, e.g. 'CSD3002' or 'salesforce'."),
    },
    async ({ query }) => {
      const baskets = parseCurriculumBaskets(await client.getCurriculumBasketsHtml());
      if (baskets.length === 0) {
        throw new VtopError(
          "UPSTREAM",
          "VTOP returned a curriculum page with no recognisable course tables.",
          "The layout may have changed.",
        );
      }
      const q = query.trim().toLowerCase();
      if (!q) {
        throw new Error("query must be a non-empty course code or title fragment.");
      }
      const matches: {
        courseCode: string;
        courseName: string;
        basket: string;
        credits: number;
        vtopMarkedCompleted: boolean;
      }[] = [];
      for (const b of baskets) {
        for (const c of b.courses) {
          if (c.code.toLowerCase().includes(q) || c.title.toLowerCase().includes(q)) {
            matches.push({
              courseCode: c.code,
              courseName: c.title,
              basket: b.category,
              credits: c.credits,
              vtopMarkedCompleted: c.vtopMarkedCompleted,
            });
          }
        }
      }
      return {
        query: query.trim(),
        count: matches.length,
        matches,
        ...(matches.length === 0
          ? { note: "No catalogue course matches. Try the course code (e.g. CSE3xxx) as listed in the registration basket." }
          : {}),
      };
    },
  );

  mkJsonTool(
    server,
    "get_pending_subjects",
    "Subjects still to complete: the curriculum baskets minus grade-history passes, with names and credits. Completion is decided ONLY by course code against the latest grade on record (a pass is any grade except F; N never counts as a pass) — period labels are never compared, because timetable labels are instructional semesters while grade-history labels are result-publication months. VTOP's own row marking is reported alongside, and any disagreement lands in discrepancies rather than being resolved silently. For elective baskets only N of M credits are required, so every uncompleted basket course is listed and the category totals say how far short. Read-only. Requires login.",
    EmptySchema.shape,
    async () => {
      const [basketsHtml, gradesHtml] = await Promise.all([
        client.getCurriculumBasketsHtml(),
        client.getGradeHistoryHtml(),
      ]);
      const baskets = parseCurriculumBaskets(basketsHtml);
      const history = parseGradeHistory(gradesHtml);
      if (baskets.length === 0) {
        throw new VtopError(
          "UPSTREAM",
          "VTOP returned a curriculum page with no recognisable course tables.",
          "The layout may have changed. Not treated as all-complete.",
        );
      }
      const { pending, completedCount, discrepancies } = computePendingSubjects(baskets, history);
      const pendingCredits = pending.reduce((s, c) => s + c.credits, 0);
      // Grouped by basket so "what is left, and from where" reads directly:
      // per basket, pending courses with their credits plus completed counts.
      const byBasket: Record<string, { pending: typeof pending; pendingCredits: number; completedCount: number; totalCount: number }> = {};
      for (const b of baskets) {
        const inBasket = pending.filter((p) => p.category === b.category);
        if (inBasket.length === 0 && !b.courses.length) continue;
        const done = b.courses.length - inBasket.length;
        byBasket[b.category] = {
          pending: inBasket,
          pendingCredits: Math.round(inBasket.reduce((s, c) => s + c.credits, 0) * 100) / 100,
          completedCount: done,
          totalCount: b.courses.length,
        };
      }
      return {
        pendingCount: pending.length,
        pendingCredits: Math.round(pendingCredits * 100) / 100,
        completedCount,
        byBasket,
        pending,
        discrepancies,
        ...(discrepancies.length > 0
          ? {
              discrepancyNote:
                "These courses disagree between VTOP's own marking and grade history. Neither side was trusted over the other — verify against the VTOP website before acting on them.",
            }
          : {}),
      };
    },
  );
}
