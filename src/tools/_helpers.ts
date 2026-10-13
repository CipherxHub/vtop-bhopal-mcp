import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
// The SDK's ToolCallback is a *conditional* type that tests its Args against
// ZodRawShapeCompat. When handed a still-generic `Shape`, that test stays
// deferred and TypeScript can never verify the callback matches — it rejects
// with a spurious "not assignable to BaseToolCallback<...>" that no correct
// annotation fixes. So we erase the generic at the registration boundary: the
// caller-facing handler keeps full `ShapeOutput<Shape>` typing, and only the
// final server.tool(...) call is widened to the erased shape.
// (tsup/esbuild never typechecks, which is why this went unnoticed upstream.)
import type {
  ShapeOutput,
  ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { z } from "zod";
import { classify, describeForModel, type VtopErrorBody } from "../services/errors.js";

type ContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Tool result shape, derived from the SDK's own `CallToolResult` so it can
 * never drift from the protocol and `structuredContent` stays valid.
 */
type ToolResult = CallToolResult;

/**
 * Render a failure as a tool result carrying BOTH representations:
 *  - `content[0].text` — prose, for the chat model and for humans.
 *  - `structuredContent.error` — a stable `code` plus an ordered `recovery`
 *    plan, so a client can branch without parsing English.
 *
 * The prose is generated from the same body, so the two can't drift apart.
 */
export function errorResult(err: unknown): ToolResult {
  const body: VtopErrorBody = classify(err).toBody();
  return {
    content: [{ type: "text", text: describeForModel(body) }],
    structuredContent: { ok: false, error: body },
    isError: true,
  };
}

/** Success result whose payload is JSON-serializable data. */
export function dataResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: { ok: true, data },
  };
}

/**
 * Register an MCP tool whose handler just returns plain JSON-serializable
 * data (or an array of content items). Wraps the handler with the standard
 * try/catch + JSON.stringify response shape so each tool file stays small.
 *
 * Every result also carries `structuredContent` (`{ok:true,data}` on success,
 * `{ok:false,error}` on failure) so clients can branch on the error code
 * instead of matching prose.
 *
 * Pass `emptyMessage` to override the "(no data)" text when the handler
 * returns an empty array.
 */
export function mkJsonTool<Shape extends ZodRawShapeCompat>(
  server: McpServer,
  name: string,
  description: string,
  schema: Shape,
  handler: (args: ShapeOutput<Shape>) => Promise<unknown | ContentItem[]>,
  opts?: { emptyMessage?: string; hints?: ToolHints }
): void {
  // Erase `Shape` for the SDK call — see the note on the imports above.
  const erasedSchema = schema as ZodRawShapeCompat;
  const callback = (async (args: ShapeOutput<ZodRawShapeCompat>) =>
    run(handler, args as unknown as ShapeOutput<Shape>, opts)) as ToolCallback<
    ZodRawShapeCompat
  >;

  server.tool(
    name,
    description,
    erasedSchema,
    // Read-only by default: clients may use these hints to auto-approve, which
    // is correct for a GET but would be dangerous for anything that writes to
    // VTOP. A tool that submits something must pass its own hints explicitly.
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true, ...opts?.hints },
    callback,
  );
}

/**
 * MCP behaviour hints. MCP clients use these to decide whether to auto-approve
 * a call or raise a permission prompt.
 */
export interface ToolHints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

async function run<Shape extends ZodRawShapeCompat>(
  handler: (args: ShapeOutput<Shape>) => Promise<unknown | ContentItem[]>,
  args: ShapeOutput<Shape>,
  opts?: { emptyMessage?: string },
): Promise<ToolResult> {
  try {
    const out = await handler(args);

    // Handler may return pre-built content items (e.g. image responses)
    if (Array.isArray(out) && out.length > 0 && isContentItem(out[0])) {
      return { content: out as ContentItem[] };
    }

    if (
      opts?.emptyMessage &&
      ((Array.isArray(out) && out.length === 0) ||
        (out && typeof out === "object" && "grades" in (out as object) &&
          Array.isArray((out as { grades: unknown[] }).grades) &&
          (out as { grades: unknown[] }).grades.length === 0))
    ) {
      return {
        content: [{ type: "text", text: opts.emptyMessage }],
        structuredContent: { ok: true, data: out },
      };
    }

    return dataResult(out);
  } catch (err: unknown) {
    return errorResult(err);
  }
}

function isContentItem(x: unknown): x is ContentItem {
  return (
    !!x &&
    typeof x === "object" &&
    "type" in x &&
    ((x as { type: string }).type === "text" ||
      (x as { type: string }).type === "image")
  );
}