#!/usr/bin/env tsx
/**
 * Offline tests for the info batch: full student profile, acknowledgments,
 * proctor details, curriculum baskets + pending subjects, fee receipts and
 * leave history — plus the get_calendar classGroup passthrough.
 *
 * Same harness shape as tool-test.ts: the real MCP machinery
 * (createServer → InMemoryTransport → SDK Client → tools/call) with a FAKE
 * VtopClient serving synthetic fixtures. No network, no credentials.
 *   npm run test:info
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { VtopClient } from "../src/services/vtop-client.js";
import type { CalendarDay } from "../src/services/attendance-calc.js";
import {
  ACK_HTML,
  CURR_BASKETS_HTML,
  FEE_RECEIPTS_HTML,
  FEE_RECEIPT_DETAIL_HTML,
  GRADES_FOR_PENDING_HTML,
  LEAVE_HISTORY_HTML,
  PROCTOR_PAGE_HTML,
  PROFILE_FULL_HTML,
} from "./fixtures.js";

let lastCalendarGroup: string | null = null;

const fakeClient = {
  async getCurrentSemesterId(): Promise<string> {
    return "TESTSEM";
  },
  async getProfileHtml(): Promise<string> {
    return PROFILE_FULL_HTML;
  },
  async getAcknowledgmentsHtml(): Promise<string> {
    return ACK_HTML;
  },
  async getProctorDetailsHtml(): Promise<string> {
    return PROCTOR_PAGE_HTML;
  },
  async getCurriculumBasketsHtml(): Promise<string> {
    return CURR_BASKETS_HTML;
  },
  async getGradeHistoryHtml(): Promise<string> {
    return GRADES_FOR_PENDING_HTML;
  },
  async getFeeReceiptsHtml(): Promise<string> {
    return FEE_RECEIPTS_HTML;
  },
  async getFeeReceiptDetailHtml(receitNo: string): Promise<string> {
    // Mirrors the real client: bare numbers resolve against the list's
    // onclick refs, full refs pass through, unknown numbers throw.
    let ref = receitNo.trim();
    if (!ref.includes("/")) {
      const m = FEE_RECEIPTS_HTML.match(
        new RegExp(`doDuplicateReceipt\\(['"](${ref}/[^'"]+)['"]\\)`),
      );
      if (!m) throw new Error(`No receipt ref on file for number "${ref}".`);
      ref = m[1];
    }
    assert.match(ref, /^\d+\/\d+\/[A-Z]+$/, "detail ref must be <no>/<seg>/<campus> shaped");
    return FEE_RECEIPT_DETAIL_HTML;
  },
  async getLeaveHistoryHtml(): Promise<string> {
    return LEAVE_HISTORY_HTML;
  },
  async getCalendar(
    _id: string,
    fromISO: string,
    toISO: string,
    classGroupId = "COMB",
  ): Promise<CalendarDay[]> {
    lastCalendarGroup = classGroupId;
    void fromISO;
    void toISO;
    return [];
  },
} as unknown as VtopClient;

let passed = 0;
const check = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

async function callJson<T = any>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  assert.equal(res.isError ?? false, false, `${name} returned isError: ${res.content?.[0]?.text}`);
  const text = res.content.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text) as T;
}

async function main() {
  const { server } = createServer(undefined, fakeClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "info-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  // get_student_profile -----------------------------------------------------
  await check("get_student_profile returns all five sections", async () => {
    const r = await callJson(client, "get_student_profile");
    assert.equal(r.sections.length, 5);
    const titles = r.sections.map((s: any) => s.title);
    for (const t of ["PERSONAL INFORMATION", "EDUCATIONAL INFORMATION", "FAMILY INFORMATION", "PROCTOR INFORMATION", "HOSTEL INFORMATION"]) {
      assert.ok(titles.includes(t), `missing section ${t}`);
    }
    const personal = r.sections.find((s: any) => s.title === "PERSONAL INFORMATION");
    assert.equal(personal.fields["STUDENT NAME"], "ADA LOVELACE");
    assert.equal(personal.fields["BLOOD GROUP"], "O+");
    const hostel = r.sections.find((s: any) => s.title === "HOSTEL INFORMATION");
    assert.equal(hostel.fields["Room No."], "A101");
  });

  // get_acknowledgments ------------------------------------------------------
  await check("get_acknowledgments lists documents and flags what is owed", async () => {
    const r = await callJson(client, "get_acknowledgments");
    assert.equal(r.count, 4);
    assert.equal(r.notSubmittedCount, 1);
    assert.deepEqual(r.stillOwed, ["Hostel Affidavit"]);
  });

  // get_proctor_details -------------------------------------------------------
  await check("get_proctor_details returns the flat contact record", async () => {
    const r = await callJson(client, "get_proctor_details");
    assert.equal(r.facultyId, "900001");
    assert.equal(r.name, "GRACE HOPPER");
    assert.equal(r.email, "grace.hopper@example.com");
    assert.equal(r.mobile, "9000000002");
  });

  // get_curriculum_baskets -----------------------------------------------------
  await check("get_curriculum_baskets parses categories with completion flags", async () => {
    const r = await callJson(client, "get_curriculum_baskets");
    assert.equal(r.categories, 2);
    assert.equal(r.courseCount, 5);
    const core = r.baskets.find((b: any) => b.category === "Programme Core");
    assert.equal(core.courses.length, 4);
    const byCode: Record<string, any> = Object.fromEntries(core.courses.map((c: any) => [c.code, c]));
    assert.equal(byCode.BTST101L.vtopMarkedCompleted, true);
    assert.equal(byCode.BTST101L.credits, 4);
    assert.equal(byCode.BTST202L.vtopMarkedCompleted, false);
    assert.equal(byCode.BTST303L.title, "Networks");
  });

  // get_pending_subjects ------------------------------------------------------
  await check("get_pending_subjects subtracts grade passes, keeps failures", async () => {
    const r = await callJson(client, "get_pending_subjects");
    // BTST101L passed (A) → out. BTST202L failed (F) → in, with latestGrade F.
    // BTST303L never taken → in, latestGrade null. BTST505L never taken → in.
    // BTST404L failed (F) → in.
    assert.equal(r.completedCount, 1);
    assert.equal(r.pendingCount, 4);
    const byCode: Record<string, any> = Object.fromEntries(r.pending.map((c: any) => [c.code, c]));
    assert.ok(!byCode.BTST101L, "passed course must not be pending");
    assert.equal(byCode.BTST202L.latestGrade, "F");
    assert.equal(byCode.BTST303L.latestGrade, null);
    assert.equal(byCode.BTST505L.category, "Programme Elective");
    assert.equal(r.pendingCredits, 15);
  });
  await check("get_pending_subjects surfaces marking disagreements, never resolves them", async () => {
    const r = await callJson(client, "get_pending_subjects");
    // BTST404L is green on the page but graded F: exactly one discrepancy.
    assert.equal(r.discrepancies.length, 1);
    assert.equal(r.discrepancies[0].courseCode, "BTST404L");
    assert.equal(r.discrepancies[0].vtopMarkedCompleted, true);
    assert.equal(r.discrepancies[0].gradeBasedCompleted, false);
    assert.ok(r.discrepancyNote, "must warn the model not to trust either side");
  });
  await check("get_pending_subjects groups leftovers by basket with counts", async () => {
    const r = await callJson(client, "get_pending_subjects");
    assert.ok(r.byBasket["Programme Core"], "core basket present");
    assert.ok(r.byBasket["Programme Elective"], "elective basket present");
    const core = r.byBasket["Programme Core"];
    assert.equal(core.totalCount, core.completedCount + core.pending.length);
    assert.equal(core.pendingCredits, core.pending.reduce((s: number, c: any) => s + c.credits, 0));
    for (const p of r.pending) assert.ok(p.category, "every pending course names its basket");
  });

  // get_course_basket ---------------------------------------------------------
  await check("get_course_basket finds a course by code with basket + credits", async () => {
    const r = await callJson(client, "get_course_basket", { query: "BTST101L" });
    assert.equal(r.count, 1);
    assert.equal(r.matches[0].basket, "Programme Core");
    assert.equal(r.matches[0].credits, 4);
  });
  await check("get_course_basket finds courses by title fragment", async () => {
    const r = await callJson(client, "get_course_basket", { query: "network" });
    assert.ok(r.count >= 1, "Networks-titled course must match");
    assert.ok(r.matches.every((m: any) => m.basket && m.courseCode));
  });
  await check("get_course_basket says so when nothing matches", async () => {
    const r = await callJson(client, "get_course_basket", { query: "ZZZ9" });
    assert.equal(r.count, 0);
    assert.match(r.note ?? "", /course code/);
  });

  // get_fee_receipts ------------------------------------------------------------
  await check("get_fee_receipts lists receipts with a total", async () => {
    const r = await callJson(client, "get_fee_receipts");
    assert.equal(r.count, 3);
    assert.equal(r.totalPaid, 257080);
    assert.equal(r.receipts[0].receiptNumber, "11111");
    assert.equal(r.receipts[1].amount, 154080);
  });
  await check("get_fee_receipts with receiptNo returns the detail breakdown", async () => {
    const r = await callJson(client, "get_fee_receipts", { receiptNo: "11111" });
    assert.equal(r.receiptNumber, "11111");
    assert.equal(r.fields["Amount Paid"], "6000.0");
    assert.equal(r.fields["Payment Mode"], "ONLINE");
  });
  await check("get_fee_receipts accepts a bare number and resolves the ref", async () => {
    // "22222" resolves against the list's VIEW buttons (22222/8/BPL here);
    // the tool echoes the requested number, not the resolved ref.
    const r = await callJson(client, "get_fee_receipts", { receiptNo: "22222" });
    assert.equal(r.receiptNumber, "22222");
    assert.ok(Object.keys(r.fields).length > 1 || !("text" in r.fields), "a real breakdown, not a text dump");
  });

  // get_leave_history -------------------------------------------------------------
  await check("get_leave_history returns every record with gate-pass state", async () => {
    const r = await callJson(client, "get_leave_history");
    assert.equal(r.count, 2);
    assert.equal(r.records[0].leaveId, "L9000001");
    assert.equal(r.records[0].status, "PROCTOR APPROVAL PENDING");
    assert.equal(r.records[0].gatePassOut, false);
    assert.equal(r.records[0].gatePassIn, false);
    assert.equal(r.records[1].leaveId, "L9000002");
    assert.equal(r.records[1].status, "REQUEST APPROVED");
    assert.equal(r.records[1].gatePassOut, true);
    assert.equal(r.records[1].gatePassIn, false);
  });

  await check("disabled modules raise ENDPOINT_NOT_FOUND instead of empty", async () => {
    // VTOP answers dead routes with HTTP 200 + error modal. Every info-page
    // getter must raise rather than parse that as "no records".
    const { VtopClient: RealClient } = await import("../src/services/vtop-client.js");
    const { VtopError } = await import("../src/services/errors.js");
    class DeadModule extends RealClient {
      override async fetchPage(): Promise<string> {
        return "<div>This menu is not available at present!!!</div>";
      }
    }
    const stub = new DeadModule("https://example.invalid/vtop");
    for (const call of [
      () => stub.getAcknowledgmentsHtml(),
      () => stub.getProctorDetailsHtml(),
      () => stub.getCurriculumBasketsHtml(),
      () => stub.getFeeReceiptsHtml(),
      () => stub.getLeaveHistoryHtml(),
    ]) {
      try {
        await call();
        assert.fail("expected ENDPOINT_NOT_FOUND");
      } catch (err) {
        assert.ok(err instanceof VtopError, "must be a coded error");
        assert.equal(err.code, "ENDPOINT_NOT_FOUND");
      }
    }
  });

  // get_calendar classGroup ---------------------------------------------------------
  await check("get_calendar defaults the class group to COMB", async () => {
    lastCalendarGroup = null;
    await callJson(client, "get_calendar", { month: "2026-01" });
    assert.equal(lastCalendarGroup, "COMB");
  });
  await check("get_calendar passes an explicit class group through", async () => {
    await callJson(client, "get_calendar", { month: "2026-01", classGroup: "FS" });
    assert.equal(lastCalendarGroup, "FS");
  });

  await client.close();
  await server.close();
  console.log(`\n${passed} checks passed.`);
}

main().catch((err) => {
  console.error("\n[info-test] FAIL:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
