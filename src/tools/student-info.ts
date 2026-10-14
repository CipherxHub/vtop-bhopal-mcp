import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VtopClient } from "../services/vtop-client.js";
import {
  parseAcknowledgments,
  parseProctorDetails,
  parseStudentProfileFull,
} from "../services/vtop-parser.js";
import { EmptySchema } from "../schemas/index.js";
import { mkJsonTool } from "./_helpers.js";

export function registerStudentInfoTools(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "get_student_profile",
    "Full student profile: the five accordion sections of VTOP's profile page (personal, educational, family, proctor, hostel information), exactly as VTOP groups them with verbatim values. Use this instead of get_profile when you need anything beyond name/programme/branch/email/phone — date of birth, addresses, board/school, parents, proctor contact, hostel block and room. Privacy: this returns sensitive PII verbatim — keep it in the student's own session, don't paste it elsewhere. If the response contains NOT_AUTHENTICATED, immediately call get_captcha then login then retry this tool. login auto-uses VTOP_USERNAME/VTOP_PASSWORD env vars if set; if login replies that credentials are missing, ask the user for their VTOP username and password and call login again with them. Requires login.",
    EmptySchema.shape,
    async () => {
      const sections = parseStudentProfileFull(await client.getProfileHtml());
      return { sections };
    },
  );

  mkJsonTool(
    server,
    "get_acknowledgments",
    "Admission document checklist: which joining documents VTOP shows as Submitted, Not Applicable, or Not Submitted (e.g. mark lists, transfer/migration/conduct certificates, affidavits). A 'Not Submitted' line is actionable — it names a document the student still owes. Read-only. Requires login.",
    EmptySchema.shape,
    async () => {
      const documents = parseAcknowledgments(await client.getAcknowledgmentsHtml());
      const notSubmitted = documents.filter((d) => /not submitted/i.test(d.status));
      return {
        count: documents.length,
        documents,
        notSubmittedCount: notSubmitted.length,
        ...(notSubmitted.length > 0
          ? { stillOwed: notSubmitted.map((d) => d.document) }
          : {}),
      };
    },
  );

  mkJsonTool(
    server,
    "get_proctor_details",
    "Proctor (faculty mentor) contact details: faculty id, name, designation, school, department, cabin, email, intercom and mobile. Same data as the proctor section of get_student_profile, via the standalone proctor page. Read-only. Requires login.",
    EmptySchema.shape,
    async () => parseProctorDetails(await client.getProctorDetailsHtml()),
  );
}
