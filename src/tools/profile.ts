import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VtopClient } from "../services/vtop-client.js";
import { parseProfile, parseProgrammeBranch } from "../services/vtop-parser.js";
import { saveDownloadFile } from "../services/download-file.js";
import { EmptySchema } from "../schemas/index.js";
import { mkJsonTool } from "./_helpers.js";

/** Sniff the file kind from magic bytes — VTOP's own content-type lies (JPEG bytes served as image/png). */
function imageExt(bytes: Buffer): "jpg" | "png" | null {
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (
    bytes.length > 3 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "png";
  return null;
}

export function registerProfileTool(server: McpServer, client: VtopClient) {
  mkJsonTool(
    server,
    "get_profile",
    "Get student profile (name, registration number, application number, program, branch, school, email, phone, blood group) plus the profile photo saved to disk as photoFile (open that file to see it — tool results carry the path, not the bytes). A null photoFile with a photoNote means VTOP served no usable image; the text fields are still good. If the response contains NOT_AUTHENTICATED, immediately call get_captcha then login then retry this tool. login auto-uses VTOP_USERNAME/VTOP_PASSWORD env vars if set; if login replies that credentials are missing, ask the user for their VTOP username and password and call login again with them. Requires login.",
    EmptySchema.shape,
    async () => {
      const profile = parseProfile(await client.getProfileHtml());
      try {
        const pb = parseProgrammeBranch(await client.getGradeHistoryHtml());
        // Assign field-by-field: an empty branch (e.g. a header reading just
        // "B.Tech") must not wipe a good profile-page value.
        if (pb?.program) profile.program = pb.program;
        if (pb?.branch) profile.branch = pb.branch;
      } catch {
        /* keep the profile-page values; grade history is a bonus */
      }
      // The photo is additive: a missing/unreadable image degrades to an
      // explicit null plus note, never fails the profile itself.
      try {
        const { bytes } = await client.downloadProfilePicture();
        const ext = imageExt(bytes);
        if (!ext) {
          return { ...profile, photoFile: null, photoNote: "VTOP answered the photo request without image bytes." };
        }
        const photoFile = saveDownloadFile("profile-photo", ext, bytes);
        if (!photoFile) {
          return { ...profile, photoFile: null, photoNote: "Photo downloaded but could not be written to disk." };
        }
        return { ...profile, photoFile, photoBytes: bytes.length };
      } catch {
        return { ...profile, photoFile: null, photoNote: "Profile photo unavailable from VTOP." };
      }
    },
  );
}
