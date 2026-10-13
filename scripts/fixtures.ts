/**
 * Synthetic VTOP HTML fixtures shaped to satisfy the real parsers. Shared by
 * parser-test.ts (parser correctness) and tool-test.ts (tool behaviour via a
 * fake client). Course codes line up across fixtures (BTST101L/BTST202L/
 * BTST101P) so attendance ↔ timetable ↔ grades cross-reference cleanly.
 */

// Attendance main page: one table#getStudentDetails serving BOTH parseAttendance
// (attended/total/% by <th> headers, <td> in fixed-width rows) and
// parseAttendanceDetailRefs (the View cell's processViewAttendanceDetail onclick).
export const ATT_MAIN_HTML = `
<table id="getStudentDetails">
  <tr>
    <th>Sl.No</th><th>Course Code</th><th>Course Title</th><th>Course Type</th>
    <th>Slot</th><th>Attended Classes</th><th>Total Classes</th>
    <th>Attendance Percentage</th><th>Attendance View</th>
  </tr>
  <tr>
    <td>1</td><td>BTST101L</td><td>Database Systems</td><td>Theory Only</td>
    <td>A1+TA1</td><td>45</td><td>50</td><td>90</td>
    <td><a onclick="javascript:processViewAttendanceDetail('CH001','A1+TA1');">View</a></td>
  </tr>
  <tr>
    <td>2</td><td>BTST202L</td><td>Marketing</td><td>Theory Only</td>
    <td>F1</td><td>30</td><td>50</td><td>60</td>
    <td><a onclick="javascript:processViewAttendanceDetail('CH002','F1');">View</a></td>
  </tr>
</table>`;

// Per-class attendance detail: 1 present, 1 absent, 2 on-duty (one a 2-period
// lab → 3 OD hours total).
export const ATT_DETAIL_HTML = `
<table>
  <tr><td>Sl.No</td><td>Attendance Date</td><td>Attendance Slot</td><td>Day And Timing</td><td>Attendance Status</td></tr>
  <tr><td>1</td><td>01-Jan-2026</td><td>A1</td><td>MON,08:00-08:50</td><td>Present</td></tr>
  <tr><td>2</td><td>03-Jan-2026</td><td>A1</td><td>WED,08:00-08:50</td><td>On Duty</td></tr>
  <tr><td>3</td><td>05-Jan-2026</td><td>L1</td><td>FRI,14:00-15:40</td><td>On Duty</td></tr>
  <tr><td>4</td><td>07-Jan-2026</td><td>A1</td><td>MON,08:00-08:50</td><td>Absent</td></tr>
</table>`;

// Per-class detail using VTOP's 12-hour AM/PM timing form, including a lab whose
// span crosses noon ("11:00 AM-01:40 PM" = 3 periods). Tests periodsFromTiming's
// AM/PM handling: 1 present + OD theory (1h) + OD lab (3h) = 4 OD hours.
export const ATT_DETAIL_AMPM_HTML = `
<table>
  <tr><td>Sl.No</td><td>Date</td><td>Slot</td><td>Day And Timing</td><td>Status</td></tr>
  <tr><td>1</td><td>01-Jan-2026</td><td>A1</td><td>Monday (09:00 AM - 09:50 AM)</td><td>Present</td></tr>
  <tr><td>2</td><td>02-Jan-2026</td><td>A1</td><td>Tuesday (02:00 PM - 02:50 PM)</td><td>On Duty</td></tr>
  <tr><td>3</td><td>03-Jan-2026</td><td>L1</td><td>Wednesday (11:00 AM - 01:40 PM)</td><td>On Duty</td></tr>
</table>`;

// Grade history with REORDERED columns (grade before credits, exam month first,
// no tr.tableContent class) to prove content-based parsing survives a layout shift.
export const GRADE_HISTORY_REORDERED_HTML = `
<table>
  <tr><td>Nov 2025</td><td>1</td><td>BTST101L</td><td>Database Systems</td><td>Theory Only</td><td>A</td><td>3</td></tr>
  <tr><td>Nov 2025</td><td>2</td><td>BTST202L</td><td>Marketing</td><td>Theory Only</td><td>B</td><td>4</td></tr>
</table>
<table>
  <tr><td>Credits Registered</td><td>Credits Earned</td><td>CGPA</td></tr>
  <tr><td>7</td><td>7</td><td>8.43</td></tr>
</table>`;

// Timetable: weekly grid (BTST101L A1 + BTST202L F1 theory, BTST101P L1 lab, all MON).
export const TIMETABLE_HTML = `<table class="w3-table-all">
<tr><td>THEORY</td><td>Start</td><td>08:00</td><td>08:55</td><td>Lunch</td></tr>
<tr><td>End</td><td>08:50</td><td>09:45</td><td>Lunch</td></tr>
<tr><td>LAB</td><td>Start</td><td>08:00</td><td>08:50</td><td>Lunch</td></tr>
<tr><td>End</td><td>08:50</td><td>09:40</td><td>Lunch</td></tr>
<tr><td>MON</td><td>THEORY</td><td>A1-BTST101L-TH-AB1-101-ALL</td><td>F1-BTST202L-TH-AB1-102-ALL</td><td>Lunch</td></tr>
<tr><td>LAB</td><td>L1-BTST101P-LO-AB1-201-ALL</td><td>A2</td><td>Lunch</td></tr>
</table>`;

// Marks: #fixedTableContainer is a <div> wrapping the table (the bug we fixed).
export const MARKS_HTML = `
<div id="fixedTableContainer"><table class="customTable">
<tr><td>Sl.No.</td><td>ClassNbr</td><td>Course Code</td><td>Course Title</td><td>Course Type</td><td>Faculty</td><td>Slot</td></tr>
<tr><td>1</td><td>CH999</td><td>BTST101L</td><td>Database Systems</td><td>Theory Only</td><td>PROF X</td><td>A1+TA1</td></tr>
<tr><td colspan="7"><table class="customTable-level1">
  <tr><td>Sl.No.</td><td>Mark Title</td><td>Max. Mark</td><td>Weightage %</td><td>Status</td><td>Scored Mark</td><td>Weightage Mark</td><td>Class Average</td></tr>
  <tr><td>1</td><td>CAT - 1</td><td>50</td><td>15</td><td>Present</td><td>40</td><td>12</td><td>30</td></tr>
</table></td></tr>
</table></div>`;

// Grade history: a CGPA summary table + per-course tr.tableContent rows.
export const GRADE_HISTORY_HTML = `
<table>
  <tr class="tableContent"><td>1</td><td>BTST101L</td><td>Database Systems</td><td>Theory Only</td><td>3</td><td>A</td><td>Nov 2025</td><td>-</td></tr>
  <tr class="tableContent"><td>2</td><td>BTST202L</td><td>Marketing</td><td>Theory Only</td><td>4</td><td>B</td><td>Nov 2025</td><td>-</td></tr>
</table>
<table>
  <tr><td>Credits Registered</td><td>Credits Earned</td><td>CGPA</td></tr>
  <tr><td>7</td><td>7</td><td>8.43</td></tr>
</table>`;

// Student profile (studentsRecord/StudentProfileAllView): a hidden regno input
// plus label/value <td> pairs that parseProfile walks.
export const PROFILE_HTML = `
<input type="hidden" name="regno" value="21BCE1234" />
<table>
  <tr><td>Student Name</td><td>Ada Lovelace</td></tr>
  <tr><td>Application Number</td><td>APP9001</td></tr>
  <tr><td>Programme</td><td>B.Tech</td></tr>
  <tr><td>Branch</td><td>Computer Science and Engineering</td></tr>
  <tr><td>School</td><td>SCOPE</td></tr>
  <tr><td>Email</td><td>ada@vitstudent.ac.in</td></tr>
  <tr><td>Mobile Number</td><td>9000000000</td></tr>
  <tr><td>Blood Group</td><td>O+ve</td></tr>
</table>`;

// One stored semester's grade view (examGradeView/doStudentGradeView): th
// headings (Course Code / Credits / Grade) + a row, ending with an SGPA cell.
export const SEMESTER_GRADES_HTML = `
<table>
  <tr><th>Sl.No</th><th>Course Code</th><th>Credits</th><th>Grade</th></tr>
  <tr><td>1</td><td>BTST101L</td><td>3</td><td>A</td></tr>
  <tr><td>2</td><td>BTST202L</td><td>4</td><td>B</td></tr>
  <tr><td colspan="4">SGPA : 8.43</td></tr>
</table>`;

// Academic-calendar month table (processViewCalendar) for parser tests.
export const CAL_HTML = `<table class="calendar-table">
<tr><th>Sunday</th><th>Monday</th><th>Saturday</th></tr>
<tr>
  <td><span>7</span></td>
  <td><span>8</span><span>Instructional Day - General (Semester)</span><span>(Working Day)</span></td>
  <td><span>13</span><span>Instructional Day - General (Semester)</span><span>(Instructional Day / Thursday Day Order)</span></td>
</tr>
</table>`;

// VIT Bhopal attendance: div#getStudentDetails wraps the table, the header row is
// <td>s (no <th>), and course/class info is combined into "Detail" cells.
export const ATT_MAIN_BHOPAL_HTML = `
<div id="getStudentDetails"><table id="AttendanceDetailDataTable">
  <thead><tr>
    <td><b>Sl.No.</b></td><td><b>Class Group</b></td><td><b>Course Detail</b></td>
    <td><b>Class Detail</b></td><td><b>Faculty Detail</b></td><td><b>Attended Classes/Days</b></td>
    <td><b>Total Classes</b></td><td><b>Attendance Percentage</b></td><td><b>Debar Status</b></td>
    <td><b>Attendance Detail</b></td>
  </tr></thead>
  <tbody><tr>
    <td><span>1</span></td><td><span>General</span></td>
    <td><span>BTST101 - Database Systems - Lecture and Tutorial Hours Only</span></td>
    <td><span>BL0000000000001 - A11+A12+A13 - AB-101</span></td>
    <td><span>SOME FACULTY - SCSE</span></td><td><span>23</span></td><td><span>31</span></td>
    <td><span><span>75%</span></span></td>
    <td><span><span><b>CAT - II : </b></span><span>Debarred &amp; Permitted</span></span></td>
    <td><a onclick="javascript: callStudentAttendanceDetailDisplay('BL0','REG','BP_BTST101_00100','LT');"></a></td>
  </tr></tbody>
</table></div>`;

// VIT Bhopal exam schedule: a "General (Semester)" row sits above the header row,
// and single-cell rows title each exam block (FAT / CAT2).
export const EXAM_SCHEDULE_BHOPAL_HTML = `
<table class="customTable">
  <tr><td colspan="13">General (Semester)</td></tr>
  <tr><td>S.No.</td><td>Course Code</td><td>Course Title</td><td>Course Type</td><td>Class ID</td><td>Slot</td>
      <td>Exam Date</td><td>Exam Session</td><td>Reporting Time</td><td>Exam Time</td><td>Venue</td>
      <td>Seat Location</td><td>Seat No.</td></tr>
  <tr><td colspan="13">FAT</td></tr>
  <tr><td>1</td><td>BTST101</td><td>Database Systems</td><td>LT</td><td>BL0000000000001</td><td>A11+A12</td>
      <td>17-Oct-2026</td><td>AN1</td><td>01:00 PM</td><td>01:15 PM - 04:15 PM</td><td> - </td><td>-</td><td>-</td></tr>
</table>`;

// VIT Bhopal grade history: course codes like ENG1004 must not be read as an
// exam month, and "P" (non-credit pass) stays out of the GPA.
export const GRADE_HISTORY_BHOPAL_HTML = `
<table class="customTable">
  <tr><td>Sl.No.</td><td>Course Code</td><td>Course Title</td><td>Course Type</td><td>Credits</td><td>Grade</td><td>Exam Month</td><td>Result Declared</td></tr>
  <tr class="tableContent"><td>1</td><td>ENG1004</td><td>Technical Communication</td><td>LT</td><td>2.0</td><td>A</td><td>Oct-2023</td><td>06-Dec-2023</td></tr>
  <tr class="tableContent"><td>2</td><td>CSE0001</td><td>Digital Literacy</td><td>LT</td><td>1.0</td><td>P</td><td>Oct-2023</td><td>06-Dec-2023</td></tr>
  <tr class="tableContent"><td>3</td><td>EEE1001</td><td>Circuits</td><td>LTP</td><td>4.0</td><td>B</td><td>Jan-2024</td><td>11-Feb-2024</td></tr>
</table>`;

// Grade-history header block carrying the degree programme + branch (Bhopal).
export const GRADE_HISTORY_HEADER_HTML = `
<table class="customTable">
  <tr><td>Reg.No.</td><td>Name</td><td>Programme and Branch</td><td>Programme Mode</td></tr>
  <tr><td>REG</td><td>NAME</td><td>B.Tech. - Electronics and Communication Engineering (AI)</td><td>Regular</td></tr>
</table>`;

// VIT Bhopal per-class detail: a one-row course summary table (whose headers also
// mention date/status) comes first; the per-class table has its header in <thead>.
export const ATT_DETAIL_BHOPAL_HTML = `
<table id="StudentCourseDetailDataTable">
  <thead><tr><td>Class Group</td><td>Course Detail</td><td>Attendance Date / Type</td><td>Attendance Status</td></tr></thead>
  <tbody><tr><td>General</td><td>BTST101 - Database Systems - LT</td><td>07-07-2026 / Manual</td><td>Present : 1 Absent : 1 On Duty : 1</td></tr></tbody>
</table>
<table id="StudentAttendanceDetailDataTable">
  <thead><tr><td>Sl.No.</td><td>Date</td><td>Slot</td><td>Day / Time</td><td>Status</td></tr></thead>
  <tbody>
    <tr><td>1</td><td>30-09-2026</td><td>A22</td><td>WED / 13:15-14:45</td><td>Present</td></tr>
    <tr><td>2</td><td>25-09-2026</td><td>A23</td><td>FRI / 13:15-14:45</td><td>On Duty</td></tr>
    <tr><td>3</td><td>23-09-2026</td><td>A22</td><td>WED / 13:15-14:45</td><td>Absent</td></tr>
  </tbody>
</table>`;

// VIT Bhopal semester grade view: "Credits" spans L P J C sub-headers (a second
// header row), plus Grading Type / Grand Total columns; GPA in a trailing row.
export const SEM_GRADES_BHOPAL_HTML = `
<table class="table">
  <tr><th rowspan="2">Sl.No.</th><th rowspan="2">Course Code</th><th rowspan="2">Course Title</th><th rowspan="2">Course Type</th>
      <th colspan="4">Credits</th><th rowspan="2">Grading Type</th><th rowspan="2">Grand Total</th><th rowspan="2">Grade</th><th rowspan="2">View Mark</th></tr>
  <tr><th>L</th><th>P</th><th>J</th><th>C</th></tr>
  <tr><td>1</td><td>BTST101</td><td>Database Systems</td><td>LT</td><td>3</td><td>0</td><td>0</td><td>3</td><td>RG</td><td>83</td><td>B</td><td></td></tr>
  <tr><td colspan="12">GPA : 8.0</td></tr>
</table>`;

// VIT Bhopal calendar cell: every program is listed ("General" first); a working
// Saturday names the weekday it follows in the General detail.
export const CAL_BHOPAL_HTML = `<table class="calendar-table">
<tr><th>Friday</th><th>Saturday</th></tr>
<tr>
  <td><span>16</span><span>Term End Examinations - General</span><span>(Term End Examinations)</span><span>No Instructional Day - Freshers</span><span>(Last Instructional Day)</span></td>
  <td><span>17</span><span>Instructional Day - General</span><span>(Remote Learning - Class/CAM Activities Friday)</span><span>Instructional Day - General BArch</span><span>(Remote Learning - Class or CAM Activities)</span></td>
</tr>
</table>`;

// Full-profile accordion page: five h2 sections, each a label/value table.
// Shapes mirror studentsRecord/StudentProfileAllView; every value is invented.
export const PROFILE_FULL_HTML = `
<h2><button class="accordion-button">PERSONAL INFORMATION</button></h2>
<div><table>
<tr><td>STUDENT NAME</td><td>ADA LOVELACE</td></tr>
<tr><td>DATE OF BIRTH</td><td>10-Dec-2004</td></tr>
<tr><td>GENDER</td><td>FEMALE</td></tr>
<tr><td>BLOOD GROUP</td><td>O+</td></tr>
<tr><td>MOBILE NUMBER</td><td>9000000001</td></tr>
<tr><td>EMAIL</td><td>ada@example.com</td></tr>
</table></div>
<h2><button class="accordion-button">EDUCATIONAL INFORMATION</button></h2>
<div><table>
<tr><td>APPLIED DEGREE</td><td>INTEGRATED PG</td></tr>
<tr><td>BOARD / UNIVERSITY</td><td>FICTIONAL BOARD</td></tr>
<tr><td>YEAR OF PASSING/ PASSED</td><td>2022</td></tr>
</table></div>
<h2><button class="accordion-button">FAMILY INFORMATION</button></h2>
<div><table>
<tr><td>FATHER NAME</td><td>CHARLES BABBAGE</td></tr>
<tr><td>OCCUPATION</td><td>TEACHING RESEARCH</td></tr>
</table></div>
<h2><button class="accordion-button">PROCTOR INFORMATION</button></h2>
<div><table>
<tr><td>FACULTY ID</td><td>900001</td></tr>
<tr><td>FACULTY NAME</td><td>GRACE HOPPER</td></tr>
<tr><td>FACULTY DESIGNATION</td><td>Assistant Professor Grade 2</td></tr>
<tr><td>SCHOOL</td><td>School of Testing</td></tr>
<tr><td>FACULTY DEPARTMENT</td><td>TEST-Department</td></tr>
<tr><td>CABIN</td><td>null</td></tr>
<tr><td>FACULTY EMAIL</td><td>grace.hopper@example.com</td></tr>
<tr><td>FACULTY INTERCOM</td><td></td></tr>
<tr><td>FACULTY MOBILE NUMBER</td><td>9000000002</td></tr>
</table></div>
<h2><button class="accordion-button">HOSTEL INFORMATION</button></h2>
<div><table>
<tr><td>Block Name</td><td>FICTIONAL BLOCK A (BOYS HOSTEL - Block)</td></tr>
<tr><td>Room No.</td><td>A101</td></tr>
<tr><td>Bed Type</td><td>2- BED -NANF</td></tr>
<tr><td>Mess Information</td><td>VEG - FOOD TEST</td></tr>
</table></div>`;

// Acknowledgment checklist: (Sl.No, document, status).
export const ACK_HTML = `
<table>
<tr><td>Sl.No.</td><td>Document</td><td>Status</td></tr>
<tr><td>1.</td><td>Mark List - HSC / +2</td><td>Submitted</td></tr>
<tr><td>2.</td><td>Transfer Certificate (or) School leaving Certificate</td><td>Submitted</td></tr>
<tr><td>3.</td><td>Hostel Affidavit</td><td>Not Submitted</td></tr>
<tr><td>4.</td><td>Nativity Certificate (if applicable)</td><td>Not Applicable</td></tr>
</table>`;

// Standalone proctor page: same table shape as the profile proctor section.
export const PROCTOR_PAGE_HTML = `
<table>
<tr><td>FACULTY ID</td><td>900001</td></tr>
<tr><td>FACULTY NAME</td><td>GRACE HOPPER</td></tr>
<tr><td>FACULTY DESIGNATION</td><td>Assistant Professor Grade 2</td></tr>
<tr><td>SCHOOL</td><td>School of Testing</td></tr>
<tr><td>FACULTY DEPARTMENT</td><td>TEST-Department</td></tr>
<tr><td>CABIN</td><td>null</td></tr>
<tr><td>FACULTY EMAIL</td><td>grace.hopper@example.com</td></tr>
<tr><td>FACULTY INTERCOM</td><td></td></tr>
<tr><td>FACULTY MOBILE NUMBER</td><td>9000000002</td></tr>
</table>`;

// Curriculum baskets: two categories; BTST101L passed (A, green), BTST202L
// failed (F, not green), BTST303L never taken (not green), BTST404L green but
// graded F (deliberate mismatch → must surface in discrepancies, not resolve).
export const CURR_BASKETS_HTML = `
<h3>Programme Core</h3>
<table>
<tr><td>Sl.No.</td><td>Course Code</td><td>Course Title</td><td>Course Type</td><td>Version</td><td>L</td><td>T</td><td>P</td><td>J</td><td>Credits</td></tr>
<tr class="bg-success odd"><td>1</td><td>BTST101L</td><td>Database Systems</td><td>Theory Only</td><td>1.0</td><td>3</td><td>1</td><td>0</td><td>0</td><td>4.0</td></tr>
<tr class="even"><td>2</td><td>BTST202L</td><td>Marketing</td><td>Theory Only</td><td>1.0</td><td>3</td><td>1</td><td>0</td><td>0</td><td>4.0</td></tr>
<tr class="odd"><td>3</td><td>BTST303L</td><td>Networks</td><td>Theory Only</td><td>1.0</td><td>3</td><td>1</td><td>0</td><td>0</td><td>4.0</td></tr>
<tr class="bg-success even"><td>4</td><td>BTST404L</td><td>Compilers</td><td>Theory Only</td><td>1.0</td><td>3</td><td>1</td><td>0</td><td>0</td><td>4.0</td></tr>
</table>
<h3>Programme Elective</h3>
<table>
<tr><td>Sl.No.</td><td>Course Code</td><td>Course Title</td><td>Course Type</td><td>Version</td><td>L</td><td>T</td><td>P</td><td>J</td><td>Credits</td></tr>
<tr class="odd"><td>1</td><td>BTST505L</td><td>Robotics</td><td>Theory Only</td><td>1.0</td><td>3</td><td>0</td><td>0</td><td>0</td><td>3.0</td></tr>
</table>`;

// Grade history backing the baskets: BTST101L A (done), BTST202L F (not done),
// BTST404L F (the mismatch: green on the page, failed on record).
export const GRADES_FOR_PENDING_HTML = `
<table>
<tr><td>Oct-2025</td><td>1</td><td>BTST101L</td><td>Database Systems</td><td>Theory Only</td><td>A</td><td>4</td></tr>
<tr><td>Oct-2025</td><td>2</td><td>BTST202L</td><td>Marketing</td><td>Theory Only</td><td>F</td><td>4</td></tr>
<tr><td>Jan-2026</td><td>1</td><td>BTST404L</td><td>Compilers</td><td>Theory Only</td><td>F</td><td>4</td></tr>
</table>
<table>
<tr><td>Credits Registered</td><td>Credits Earned</td><td>CGPA</td></tr>
<tr><td>12</td><td>4</td><td>5.00</td></tr>
</table>`;

// Fee receipt list: three receipts; VIEW buttons carry doDuplicateReceipt refs.
export const FEE_RECEIPTS_HTML = `
<input type="hidden" name="applno" value="TESTAPPL001" />
<input type="hidden" name="regno" value="21BCE1234" />
<table>
<tr><td>RECEIPT NUMBER</td><td>DATE</td><td>AMOUNT</td><td>CAMPUS CODE</td><td>VIEW</td></tr>
<tr><td>11111</td><td>09-JUL-2026</td><td>6000.0</td><td>BHOPAL</td><td><button onclick="javascript:doDuplicateReceipt('11111/8/BPL');">view</button></td></tr>
<tr><td>22222</td><td>03-JUL-2026</td><td>154080.0</td><td>BHOPAL</td><td><button onclick="javascript:doDuplicateReceipt('22222/8/BPL');">view</button></td></tr>
<tr><td>33333</td><td>12-JUN-2026</td><td>97000.0</td><td>BHOPAL</td><td><button onclick="javascript:doDuplicateReceipt('33333/8/BPL');">view</button></td></tr>
</table>`;

// One receipt's detail panel, as rendered into the page.
export const FEE_RECEIPT_DETAIL_HTML = `
<table>
<tr><td>Receipt Number</td><td>11111</td></tr>
<tr><td>Receipt Date</td><td>09-JUL-2026</td></tr>
<tr><td>Student Name</td><td>ADA LOVELACE</td></tr>
<tr><td>Amount Paid</td><td>6000.0</td></tr>
<tr><td>Payment Mode</td><td>ONLINE</td></tr>
</table>`;

// Leave history: two records with gate-pass icon cells (present vs absent).
export const LEAVE_HISTORY_HTML = `
<table>
<tr><td>Leave Id</td><td>Visit Place</td><td>Reason</td><td>Leave Type</td><td>From</td><td>To</td><td>Status</td><td>Remarks</td><td>Gate Pass OUT</td><td>Gate Pass IN</td></tr>
<tr><td>L9000001</td><td>Home</td><td>Diwali break at home.</td><td>WINTER VACATION</td><td>30-OCT-2026 17:00</td><td>15-NOV-2026 21:00</td><td>PROCTOR APPROVAL PENDING</td><td>REQUEST RAISED</td><td></td><td></td></tr>
<tr><td>L9000002</td><td>Sehore</td><td>Medical check-up.</td><td>SPECIAL OUTING</td><td>07-OCT-2026 12:29</td><td>07-OCT-2026 18:30</td><td>REQUEST APPROVED</td><td>by [ 900001 ] [ GRACE HOPPER ]</td><td><i class="glyphicon"></i></td><td></td></tr>
</table>`;
