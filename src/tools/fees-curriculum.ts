import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VtopClient } from "../services/vtop-client.js";
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
        const ref = /^\d+\/\d+\/[A-Z]+$/.test(receiptNo.trim())
          ? receiptNo.trim()
          : `${receiptNo.trim()}/8/BPL`;
        return parseFeeReceiptDetail(
          receiptNo.trim(),
          await client.getFeeReceiptDetailHtml(ref),
        );
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
      return {
        categories: baskets.length,
        courseCount: baskets.reduce((s, b) => s + b.courses.length, 0),
        baskets,
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
      const { pending, completedCount, discrepancies } = computePendingSubjects(baskets, history);
      const pendingCredits = pending.reduce((s, c) => s + c.credits, 0);
      return {
        pendingCount: pending.length,
        pendingCredits: Math.round(pendingCredits * 100) / 100,
        completedCount,
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
