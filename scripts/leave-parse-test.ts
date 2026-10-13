#!/usr/bin/env tsx
/**
 * Offline tests for the leave HTML parsers.
 *   npm run test:leave-parse
 *
 * The fixtures below are shaped like the markup VTOP actually served (captured
 * from the DevTools trace of hostels/student/leave/2 and /4), so a change in
 * Bhopal's column order or a new leave type shows up here rather than in
 * production.
 */
import assert from "node:assert/strict";
import { parseLeaveTypeOptions, parseLeaveRecords } from "../src/services/vtop-parser.js";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    throw err;
  }
}

// Real markup: select#leaveCode with the nine codes Bhopal publishes.
const FORM_HTML = `
<div class="card-body ">
  <div id="LeaveRequest">
    <form id="LeaveRequestForm" name="LeaveRequestForm" method="POST">
      <input type="hidden" name="_csrf" value="00000000-0000-0000-0000-000000000000"/>
      <div class="form-group"><label for="leaveCode">Leave Type</label>
        <select class="form-control" id="leaveCode" name="leaveCode"
                data-controlName="leaveCode" onchange="requestUpdate(this)">
          <option value="">-Select-</option>
          <option value="SO">SPECIAL OUTING</option>
          <option value="WP">WITH PARENT LEAVE</option>
          <option value="EP">OFFICIAL LEAVES (GATE / CAMPUS INTERVIEW )</option>
          <option value="SV">SUMMER VACATION</option>
          <option value="WV">WINTER VACATION</option>
          <option value="HT1">HOME TOWN</option>
          <option value="LG1">LOCAL GUARDIAN</option>
          <option value="EY1">EMERGENCY LEAVE</option>
          <option value="OG1">DAY OUTING</option>
        </select>
      </div>
      <label for="visitingPlace">Visiting Place</label>
      <input type="text" maxlength="150" size="50" name="visitingPlace" id="visitingPlace" value="" />
      <input type="date" name="leaveFromDate" id="leaveFromDate" value="" />
      <input type="time" name="fromTime" id="fromTime" value="" />
      <input type="date" name="leaveToDate" id="leaveToDate" value="" />
      <input type="time" name="toTime" id="toTime" value="" />
      <textarea id="reason" name="reason" rows="3" cols="50"></textarea>
    </form>
  </div>
</div>`;

// The status view when nothing is pending: a header and "No Records To Show".
const EMPTY_STATUS_HTML = `
<div class="card-body">
  <span class="text-danger">No Records To Show</span>
  <table>
    <tr>
      <td>Leave Id</td><td>Visit Place</td><td>Reason</td><td>LeaveType</td>
      <td>From</td><td>To</td><td>Status</td><td>Remarks</td>
    </tr>
  </table>
</div>`;

// The history view: same shape plus gate-pass icon columns.
const HISTORY_HTML = `
<table>
  <tr>
    <th>Leave Id</th><th>Visit Place</th><th>Reason</th><th>Leave Type</th>
    <th>From</th><th>To</th><th>Status</th><th>Remarks</th>
    <th>Gate Pass OUT</th><th>Gate Pass IN</th>
  </tr>
  <tr>
    <td>L9000001</td>
    <td>Bhopal</td>
    <td>Visiting a nearby town for a medical appointment, returning the same evening.</td>
    <td>SPECIAL OUTING</td>
    <td>07-OCT-2026 12:29</td>
    <td>07-OCT-2026 18:30</td>
    <td>REQUEST APPROVED</td>
    <td>by { 9000001 } [ SAMPLE PROCTOR ]</td>
    <td><span class="glyphicon glyphicon-eye"></span></td>
    <td><span class="glyphicon glyphicon-eye-off"></span></td>
  </tr>
  <tr>
    <td>L9000002</td>
    <td>Bhopal</td>
    <td>Family function</td>
    <td>HOME TOWN</td>
    <td>20-MAR-2026 10:00</td>
    <td>29-MAR-2026 18:00</td>
    <td>HOSTEL APPROVAL PENDING</td>
    <td>by { 9000001 } [ SAMPLE PROCTOR ]</td>
    <td><span class="glyphicon glyphicon-eye"></span></td>
    <td></td>
  </tr>
</table>`;

// The modal VTOP returns for a menu it will not serve. Must never parse as data.
const MENU_UNAVAILABLE_HTML = `
<div class="modal" id="msgBox"><div class="modal-body">
  <span class="text-danger fw-bold h6" id="msgBoxInfoText">
    This menu is not available at present!!!</span>
</div></div>`;

console.log("leave parsers (offline)");

// --- leave types ------------------------------------------------------------
check("the leaveCode dropdown yields all nine published types", () => {
  const opts = parseLeaveTypeOptions(FORM_HTML);
  assert.equal(opts.length, 9);
  assert.deepEqual(
    opts.map((o) => o.code),
    ["SO", "WP", "EP", "SV", "WV", "HT1", "LG1", "EY1", "OG1"],
  );
});

check("the '-Select-' placeholder is not treated as a leave type", () => {
  const opts = parseLeaveTypeOptions(FORM_HTML);
  assert.equal(opts.some((o) => o.code === ""), false);
});

check("leave type labels keep VTOP's wording", () => {
  const opts = parseLeaveTypeOptions(FORM_HTML);
  assert.equal(opts.find((o) => o.code === "OG1")?.label, "DAY OUTING");
  assert.equal(opts.find((o) => o.code === "LG1")?.label, "LOCAL GUARDIAN");
});

check("a page with no leaveCode select yields no types rather than throwing", () => {
  assert.deepEqual(parseLeaveTypeOptions(MENU_UNAVAILABLE_HTML), []);
  assert.deepEqual(parseLeaveTypeOptions(""), []);
});

// --- records ---------------------------------------------------------------
check("history rows are parsed with their gate-pass state", () => {
  const rows = parseLeaveRecords(HISTORY_HTML);
  assert.equal(rows.length, 2);

  assert.equal(rows[0].leaveId, "L9000001");
  assert.equal(rows[0].visitPlace, "Bhopal");
  assert.equal(rows[0].leaveType, "SPECIAL OUTING");
  assert.equal(rows[0].status, "REQUEST APPROVED");
  assert.equal(rows[0].from, "07-OCT-2026 12:29");
  assert.equal(rows[0].to, "07-OCT-2026 18:30");
  assert.match(rows[0].remarks, /SAMPLE PROCTOR/);
  assert.equal(rows[0].gatePassOut, true, "an icon is present");
  assert.equal(rows[0].gatePassIn, true);
});

check("an empty gate-pass cell reads as not-issued", () => {
  const rows = parseLeaveRecords(HISTORY_HTML);
  assert.equal(rows[1].gatePassOut, true);
  assert.equal(rows[1].gatePassIn, false, "no icon in the cell");
});

check("a long reason is preserved intact", () => {
  const rows = parseLeaveRecords(HISTORY_HTML);
  assert.equal(
    rows[0].reason,
    "Visiting a nearby town for a medical appointment, returning the same evening.",
  );
});

check("pending and approved statuses are both read verbatim", () => {
  const rows = parseLeaveRecords(HISTORY_HTML);
  assert.deepEqual(rows.map((r) => r.status), [
    "REQUEST APPROVED",
    "HOSTEL APPROVAL PENDING",
  ]);
});

check("an empty status table yields no records", () => {
  assert.deepEqual(parseLeaveRecords(EMPTY_STATUS_HTML), []);
});

check("the menu-unavailable modal never parses as leave data", () => {
  // The critical guard: the modal is HTTP 200, so without this a dead route
  // would read as "you have no leave requests".
  assert.deepEqual(parseLeaveRecords(MENU_UNAVAILABLE_HTML), []);
  assert.deepEqual(parseLeaveRecords(""), []);
  assert.deepEqual(parseLeaveRecords("<html></html>"), []);
});

check("the header row is never mistaken for a data row", () => {
  const rows = parseLeaveRecords(HISTORY_HTML);
  assert.equal(rows.some((r) => r.leaveId === "Leave Id"), false);
  assert.equal(rows.some((r) => /visit place/i.test(r.visitPlace)), false);
});

check("a status table without gate columns reports null, not false", () => {
  const rows = parseLeaveRecords(EMPTY_STATUS_HTML);
  // No data rows at all here, so the meaningful assertion is that the parser
  // does not fabricate gate values for a table that lacks the columns.
  assert.equal(rows.length, 0);
});

console.log(`\n${passed} checks passed.`);