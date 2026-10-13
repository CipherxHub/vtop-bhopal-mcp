import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VtopClient } from "../services/vtop-client.js";
import type { Credentials } from "../types/index.js";
import { LoginSchema, EmptySchema } from "../schemas/index.js";
import { mkJsonTool, errorResult } from "./_helpers.js";
import { VtopError, type VtopErrorBody } from "../services/errors.js";

export function registerAuthTools(
  server: McpServer,
  client: VtopClient,
  credentials?: Credentials,
) {
  // get_captcha returns an image content item, not JSON — use server.tool directly.
  server.tool(
    "get_captcha",
    "Step 1 of login: fetch a CAPTCHA image from VTOP. Returns the image so you (the model) can OCR it. After this, immediately call `login` with the captcha text you read — do NOT ask the user to read it for you. The user only needs to be asked for credentials if VTOP_USERNAME / VTOP_PASSWORD are not set as env vars on the server. Failures come back as structuredContent.error.code (e.g. RECAPTCHA_REQUIRED, CAPTCHA_NOT_FOUND) with an ordered `recovery` plan.",
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
          return {
            content: [
              { type: "image" as const, data: match[2], mimeType: match[1] },
              {
                type: "text" as const,
                text:
                  "Captcha image retrieved. Read the text in the image and use it with the login tool. If you cannot read it, call get_captcha again for a new one.",
              },
            ],
            structuredContent: {
              ok: true,
              data: { captchaReturned: true, mimeType: match[1] },
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
        return {
          content: [{ type: "text" as const, text: result.message }],
          structuredContent: { ok: true, data: { success: true } },
        };
      } catch (err: unknown) {
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
    "Get list of available semesters (id + name). Most data tools accept the semesterId, but they also default to the current semester if omitted — so you usually don't need to call this unless the user asks about a specific past semester. On failure the response carries structuredContent.error.code; if it is NOT_AUTHENTICATED, follow the error's `recovery` array (get_captcha then login) and retry this tool.",
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