import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VtopClient } from "../services/vtop-client.js";
import type { Credentials } from "../types/index.js";
import { LoginSchema, EmptySchema } from "../schemas/index.js";
import { mkJsonTool, errorResult } from "./_helpers.js";
import { saveCaptchaFile, openCaptchaImage } from "../services/captcha-file.js";
import { VtopError, type VtopErrorBody } from "../services/errors.js";

/** Rejected captcha attempts in a row before we hand the problem to the user. */
const CAPTCHA_MISREAD_LIMIT = 3;

/** Process-local misread counter. Reset on any successful login. */
let captchaMisreads = 0;

export function registerAuthTools(
  server: McpServer,
  client: VtopClient,
  credentials?: Credentials,
) {
  // get_captcha returns an image content item, not JSON — use server.tool directly.
  server.tool(
    "get_captcha",
    "Step 1 of login: fetch a CAPTCHA image from VTOP. Returns the image AND saves it to a file. CRITICAL - never invent the characters. If no image is rendered above, you cannot read the captcha: do NOT guess. Open `captchaFile` from the response and read that, or ask the user to open it and tell you the characters. A guess is always wrong and counts as a real failed login attempt against the student's account. After reading it, immediately call `login` — the image is only valid for 30-60 seconds. Failures come back as structuredContent.error.code (e.g. RECAPTCHA_REQUIRED, CAPTCHA_NOT_FOUND) with an ordered `recovery` plan.",
    EmptySchema.shape,
    // Reads a captcha + arms the prelogin session: not read-only, but not
    // destructive either (no user data is changed). The hints stop MCP clients
    // from flagging it as a destructive write and prompting on every call.
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async () => {
      // If a session already exists (restored from the store, or from an earlier
      // call in this process), there's nothing to log into — skip the captcha so
      // we don't waste an OCR round and risk an unnecessary login failure.
      if (client.isAuthenticated) {
        const data = {
          alreadyAuthenticated: true,
          message:
            "You already have an active VTOP session — no captcha or login needed. Call the data tool you need directly. Only call get_captcha again if a tool returns NOT_AUTHENTICATED.",
        };
        return {
          content: [{ type: "text" as const, text: data.message }],
          structuredContent: { ok: true, data },
        };
      }
      try {
        const dataUrl = await client.getCaptcha();
        const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (match) {
          // Save a copy so clients that drop `image` content blocks still have
          // a way to reach it. The image block stays first for clients that
          // render it — this is additive, not a replacement.
          const captchaFile = saveCaptchaFile(match[1], match[2]);
          const opened = captchaFile ? openCaptchaImage(captchaFile) : false;
          const text = captchaFile
            ? opened
              ? "Captcha retrieved and OPENED IN AN IMAGE VIEWER on the user's screen, and " +
                `saved to ${captchaFile}.\n\n` +
                "If the user is present, ask them to read the characters off that window and " +
                "give them to you, then call `login` immediately. If you can see an attached " +
                `image above, read it yourself instead. NEVER guess the characters - a wrong ` +
                "guess is a real failed login attempt against the student's account and VTOP " +
                "locks accounts after repeated failures. The image expires in 30-60 seconds."
              : "Captcha retrieved. The image is attached above AND saved to a file.\n\n" +
                `If you can see the attached image, read it and call \`login\`. If NO image is ` +
                `rendered above, your client does not display image content blocks: open ` +
                `${captchaFile} and read that instead. NEVER guess the characters - a wrong ` +
                `guess is a real failed login attempt against the student's account, and VTOP ` +
                `locks accounts after repeated failures. The image expires in 30-60 seconds.`
            : "Captcha retrieved (attached above). If no image is rendered, your client does " +
              "not display image content blocks and the file save failed - ask the user to fetch " +
              "it themselves rather than guessing. NEVER guess the characters.";

          return {
            content: [
              { type: "image" as const, data: match[2], mimeType: match[1] },
              { type: "text" as const, text },
            ],
            structuredContent: {
              ok: true,
              data: {
                captchaReturned: true,
                mimeType: match[1],
                captchaFile,
                openedInViewer: opened,
                imageRendered: false,
                instructions: {
                  canReadImage: "Read the attached image, then call login immediately.",
                  cannotSeeImage: opened
                    ? "The image has been opened in a viewer on the user's screen. Ask them to " +
                      "read it and give you the characters, then call login."
                    : "Your client is not rendering image content blocks. Open `captchaFile` " +
                      "and read the characters from it, or ask the user to open it. Do not guess.",
                  expiresInSeconds: "30-60",
                  neverGuess: true,
                },
              },
            },
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Captcha data URL: ${dataUrl.slice(0, 100)}...`,
            },
          ],
        };
      } catch (err: unknown) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "login",
    "Step 2 of login: submit credentials + the captcha you just OCR'd. Username/password are optional — if VTOP_USERNAME and VTOP_PASSWORD are set as env vars on the MCP server, omit them and the server uses the stored values. Only ask the user for credentials if the server reports they're not configured. Failures return structuredContent.error with a `code` and `needsUserInput`; on CREDENTIALS_REQUIRED the captcha you already hold is still valid, so reuse it rather than fetching a new one.",
    LoginSchema.shape,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ username, password, captcha }) => {
      // Already authenticated (e.g. a restored session) — don't re-login.
      if (client.isAuthenticated) {
        const data = {
          success: true,
          alreadyAuthenticated: true,
          message:
            "Already logged in to VTOP — no need to log in again. Proceed directly to the data tool you need.",
        };
        return {
          content: [{ type: "text" as const, text: data.message }],
          structuredContent: { ok: true, data },
        };
      }
      const user = username ?? credentials?.username ?? process.env.VTOP_USERNAME;
      const pass = password ?? credentials?.password ?? process.env.VTOP_PASSWORD;
      if (!user || !pass) {
        return errorResult(
          new VtopError(
            "CREDENTIALS_REQUIRED",
            "No VTOP username/password is configured on the server.",
          ),
        );
      }
      try {
        const result = await client.login(user, pass, captcha);
        captchaMisreads = 0;
        return {
          content: [{ type: "text" as const, text: result.message }],
          structuredContent: { ok: true, data: { success: true } },
        };
      } catch (err: unknown) {
        // Escalate rather than let the model burn the account.
        //
        // docs/errors.md has always said "after three misreads the assistant
        // should show you the image and ask", but that was prose, not
        // behaviour, and it did not survive contact with reality: observed in
        // the wild, a model that could not see the captcha guessed three times
        // in a row, each guess a real failed login against a student's VTOP
        // account. VTOP locks accounts on repeated failures, so a fourth guess
        // can cost the student access until someone resets it in a browser.
        if (err instanceof VtopError && err.code === "INVALID_CAPTCHA") {
          captchaMisreads += 1;
          if (captchaMisreads >= CAPTCHA_MISREAD_LIMIT) {
            captchaMisreads = 0;
            return errorResult(
              new VtopError(
                "INVALID_CAPTCHA",
                `Rejected ${CAPTCHA_MISREAD_LIMIT} times in a row. STOP retrying — do not ` +
                  "call login or get_captcha again on your own.\n\n" +
                  "Ask the user for help: tell them the captcha could not be read, show the " +
                  "image file path from the last get_captcha call, and ask them to open it and " +
                  "type the characters back to you. VTOP locks accounts after repeated failed " +
                  "attempts, so continuing to guess risks the student losing access until it is " +
                  "reset in a browser.",
                "Repeated captcha misreads — human assistance required.",
              ),
            );
          }
        }
        return errorResult(err);
      }
    }
  );

  /**
   * Cheap, read-only probe of session state. Lets the model check whether it
   * needs to log in — or answer "am I logged in?" — without burning a captcha
   * round-trip or guessing from a failed data call.
   *
   * `probe: true` additionally verifies the session against VTOP itself, which
   * is the only way to catch a session that died server-side while our local
   * flag still said "authenticated".
   */
  server.tool(
    "session_status",
    "Report the current VTOP session state: whether a session is active, the registration number, whether credentials are configured, and (with `probe: true`) whether VTOP still considers the session valid. Call this before logging in if unsure, or when a data tool returns NOT_AUTHENTICATED. Read-only — it never changes anything. Does not require login.",
    EmptySchema.shape,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async () => {
      const hasEnvCredentials = !!(
        process.env.VTOP_USERNAME && process.env.VTOP_PASSWORD
      );
      const hasArgCredentials = !!(credentials?.username && credentials?.password);

      if (!client.isAuthenticated) {
        const body: VtopErrorBody = new VtopError(
          "NOT_AUTHENTICATED",
          "No active VTOP session.",
        ).toBody();
        const data = {
          authenticated: false,
          registrationNumber: null,
          credentialsConfigured: hasEnvCredentials || hasArgCredentials,
          credentialsSource: hasEnvCredentials ? "env" : hasArgCredentials ? "connector" : null,
          serverValidated: false,
          nextStep: hasEnvCredentials || hasArgCredentials ? ["get_captcha", "login"] : ["get_captcha", "login", "ask_user_for_credentials"],
        };
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Not logged in. " +
                (data.credentialsConfigured
                  ? "Credentials are configured on the server — call get_captcha, read it, then call login."
                  : "No credentials are configured — call get_captcha, then ask the user for their VTOP username and password, then call login."),
            },
          ],
          structuredContent: { ok: true, data },
        };
      }

      const data: Record<string, unknown> = {
        authenticated: true,
        registrationNumber: client.registrationNumber,
        credentialsConfigured: hasEnvCredentials || hasArgCredentials,
        credentialsSource: hasEnvCredentials ? "env" : hasArgCredentials ? "connector" : "session",
        serverValidated: false,
      };

      // Verify against VTOP so a server-side expiry is caught here rather than
      // on the user's next real question.
      const alive = await client.keepAlive();
      data.serverValidated = true;
      data.sessionAlive = alive;
      if (!alive) {
        // keepAlive() clears the local flag ONLY when VTOP actually reported
        // expiry; on a transient network error it stays authenticated. Trust
        // the flag, not the probe result, so a blip isn't misreported as
        // "logged out".
        const stillLocal = client.isAuthenticated;
        data.authenticated = stillLocal;
        if (!stillLocal) data.nextStep = ["get_captcha", "login"];
      }

      const confirmed = data.authenticated === true;
      return {
        content: [
          {
            type: "text" as const,
            text: confirmed
              ? `Logged in to VTOP as ${client.registrationNumber ?? "unknown student"}; VTOP confirmed the session is still valid.`
              : "VTOP rejected the stored session — it has expired. Call get_captcha, read it, then call login again.",
          },
        ],
        structuredContent: { ok: true, data },
      };
    }
  );

  mkJsonTool(
    server,
    "get_semesters",
    "Get list of available semesters (id + name). IMPORTANT ORDERING: VTOP returns these NEWEST-FIRST -- index 0 is the current (in-progress) term and the LAST element is the OLDEST. To reach the most recent COMPLETED term use index 1, not the last element; taking the last element silently returns the student's first semester. Most data tools accept the semesterId, but they also default to the current semester if omitted — so you usually don't need to call this unless the user asks about a specific past semester. On failure the response carries structuredContent.error.code; if it is NOT_AUTHENTICATED, follow the error's `recovery` array (get_captcha then login) and retry this tool.",
    EmptySchema.shape,
    async () => client.getSemesters(),
    { emptyMessage: "No semesters found. You may not be enrolled yet." }
  );

  server.tool(
    "logout",
    "Logout from VTOP and clear the session.",
    EmptySchema.shape,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async () => {
      await client.logout();
      return {
        content: [{ type: "text" as const, text: "Successfully logged out." }],
        structuredContent: { ok: true, data: { success: true } },
      };
    }
  );
}