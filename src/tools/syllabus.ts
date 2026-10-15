import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VtopClient } from "../services/vtop-client.js";
import { VtopError } from "../services/errors.js";
import { saveDownloadFile } from "../services/download-file.js";
import { CourseSyllabusSchema } from "../schemas/index.js";
import { mkJsonTool } from "./_helpers.js";

export function registerSyllabusTools(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "get_course_syllabus",
    "Download a course's syllabus PDF (My Curriculum → the download icon beside each course code): pass a course code and get back the saved file path plus its size. The PDF is written under VTOP_DOWNLOAD_DIR (default OS temp dir) as syllabus-{CODE}.pdf — open that file to read it, since MCP tool results carry the path, not the bytes. Read-only. Requires login. If the response contains NOT_AUTHENTICATED, immediately call get_captcha then login then retry this tool. login auto-uses VTOP_USERNAME/VTOP_PASSWORD env vars if set; if login replies that credentials are missing, ask the user for their VTOP username and password and call login again with them.",
    CourseSyllabusSchema.shape,
    async ({ courseCode }) => {
      const code = courseCode.trim().toUpperCase();
      if (!/^[A-Z]{2,5}\d{3,4}[A-Z]?$/.test(code)) {
        throw new Error(`"${courseCode.trim()}" is not shaped like a VIT course code (e.g. CSD3010, CSE3003).`);
      }
      const { bytes, contentType } = await client.downloadCourseSyllabus(code);
      // VTOP answers failures as HTTP 200 HTML; a non-PDF here is a failed
      // download wearing a success status — fail loud, never save it as .pdf.
      if (bytes.subarray(0, 4).toString() !== "%PDF") {
        throw new VtopError(
          "UPSTREAM",
          `VTOP did not return a syllabus PDF for "${code}" (served ${contentType || "unknown type"}, ${bytes.length} bytes).`,
          "The course may have no published syllabus, or the catalogue code differs from the registered one.",
        );
      }
      const file = saveDownloadFile(`syllabus-${code}`, "pdf", bytes);
      if (!file) {
        throw new Error(
          "Downloaded the syllabus but could not write it to disk. Set VTOP_DOWNLOAD_DIR to a writable directory and retry.",
        );
      }
      return {
        courseCode: code,
        file,
        bytes: bytes.length,
        contentType,
      };
    },
  );
}
