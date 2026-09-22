import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  acceptedContent,
  inputRequired,
  type CallToolResult,
  type ClientCapabilities,
  type ContentBlock,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  CAPABILITY_BY_NAME,
  isJsonObject,
  type ExecuteRequest,
  type JsonValue,
  type Operation,
} from "@compositor-mcp/protocol";
import type { BridgeTransport } from "./bridge-client.js";
import { CompositorMcpError, normaliseError } from "./errors.js";
import { handleExecute, handleSearch, inspectRequest, requireDestructiveConfirmation } from "./handlers.js";
import { registerWorkflowPrompts } from "./prompts.js";
import { PreviewCache, captureLatestPreview, registerCompositorResources } from "./resources.js";

const jsonObjectSchema = z.record(z.string(), z.unknown());

const operationSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("Catalogue operation name, e.g. 'layer.setOpacity'. Discover valid names and their schemas with the search tool."),
  arguments: jsonObjectSchema
    .optional()
    .describe("Operation arguments matching the operation's inputSchema — call search with includeSchemas to fetch it."),
  precondition: z
    .object({
      projectId: z
        .string()
        .optional()
        .describe("Expected project id ('current' or a projects[].id from state). Fails with project_conflict when it no longer matches."),
      documentId: z
        .string()
        .optional()
        .describe("Expected document id (document.id from state). Fails with document_conflict when the open document changed."),
      revision: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Expected editor revision — take it from a state resource read or an execute result's revision field. Fails with revision_conflict on drift."),
    })
    .optional()
    .describe("Optimistic-concurrency guard checked against the live editor before the operation runs."),
});

/// Advertised on tools/list and enforced by the SDK: every search hit carries
/// the catalogue fields the summary and full forms share; inputSchema/examples
/// ride along as loose extras when includeSchemas is on.
const searchOutputSchema = z.looseObject({
  query: z.string(),
  count: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  results: z.array(
    z.looseObject({
      score: z.number(),
      capability: z.looseObject({
        name: z.string(),
        title: z.string(),
        description: z.string(),
        category: z.string(),
        risk: z.enum(["read", "write", "destructive", "filesystem"]),
        status: z.enum(["implemented", "planned"]),
        transactional: z.boolean(),
        aliases: z.array(z.string()),
        tags: z.array(z.string()),
      }),
    }),
  ),
  hint: z.string(),
});

/// The bridge's execute envelope: batch/atomic result plus the optional
/// dry-run, rollback, mutation, revision and state fields the router emits.
const executeOutputSchema = z.looseObject({
  ok: z.boolean(),
  results: z.array(
    z.looseObject({
      index: z.number().int().nonnegative(),
      name: z.string(),
      ok: z.boolean(),
      value: z.unknown().optional(),
      error: z.looseObject({ code: z.string(), message: z.string() }).optional(),
    }),
  ),
  dryRun: z.boolean().optional(),
  atomic: z.boolean().optional(),
  rolledBack: z.boolean().optional(),
  mutated: z.boolean().optional(),
  revision: z.number().optional(),
  state: z.unknown().optional(),
});

/// Form-mode elicitation schema for the destructive-confirmation prompt —
/// a Standard Schema, converted by inputRequired.elicit to the restricted wire
/// shape elicitation/create accepts on both protocol eras, and reused by
/// acceptedContent to validate the client's answer on re-entry.
const CONFIRM_ELICIT_SCHEMA = z.object({
  confirm: z.boolean().describe("Run the destructive operations now."),
});

/// Served in the initialize result — the workflow contract a client should
/// follow: discover operations via search, batch them through execute, and
/// gate risk behind dryRun and confirmDestructive.
const SERVER_INSTRUCTIONS =
  "Compositor is driven through two tools. Call search first to discover operation names, risk classes and input " +
  "schemas — never guess operation names. Then call execute with a batch of operations; batches are atomic by " +
  "default and return per-operation results plus a fresh state snapshot and revision. Use dryRun: true to validate " +
  "a risky batch without mutating. Batches containing destructive operations need confirmDestructive: true (or an " +
  "accepted confirmation prompt). Pass the returned revision back as an operation precondition to detect editor drift.";

export function createCompositorMcpServer(transport: BridgeTransport): McpServer {
  const server = new McpServer(
    {
      name: "compositor-mcp-server",
      version: "0.1.0",
    },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const previews = new PreviewCache();

  server.registerTool(
    "search",
    {
      title: "Search capabilities",
      description:
        "Search Compositor's capability catalogue using natural language. Returns operation names, risk, implementation status and JSON schemas without loading the whole catalogue into context.",
      inputSchema: z.object({
        query: z.string().default("").describe("Natural-language or operation-name search text, e.g. 'blur the background'."),
        limit: z.number().int().min(1).max(50).default(10).describe("Maximum hits to return (1–50); check total/truncated in the result."),
        includeSchemas: z.boolean().default(true).describe("Include each operation's JSON inputSchema and examples in the results."),
        includePlanned: z.boolean().default(false).describe("Also list operations that are documented but not yet implemented by the bridge."),
      }),
      outputSchema: searchOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => asToolResult(handleSearch(input)),
  );

  server.registerTool(
    "execute",
    {
      title: "Execute operations",
      description:
        "Execute one or more typed Compositor operations. Supports dry-run validation, optimistic preconditions, undo-grouped atomic batches, idempotency keys and explicit confirmation for destructive edits.",
      inputSchema: z.object({
        operations: z
          .array(operationSchema)
          .min(1)
          .max(100)
          .describe("Operations to run in order — 1 to 100 per batch. Search first to discover names and schemas."),
        atomic: z
          .boolean()
          .default(true)
          .describe("Roll the whole batch back when one operation fails, as a single undo group. Required unless the batch mixes file/workspace operations."),
        dryRun: z
          .boolean()
          .default(false)
          .describe("Validate every operation against the live document without mutating — use it for risky or complex batches first."),
        confirmDestructive: z
          .boolean()
          .default(false)
          .describe("Required to run destructive operations (e.g. layer.delete, pixels.clear); an elicitation-capable client is asked first."),
        idempotencyKey: z
          .string()
          .min(8)
          .max(200)
          .optional()
          .describe("8–200 character key; a retried batch with the same key replays the cached result instead of re-running."),
      }),
      outputSchema: executeOutputSchema,
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input, ctx) => {
      const request = input as ExecuteRequest;
      // The confirmation gate runs before the batch: it may upgrade
      // confirmDestructive from an accepted elicitation, return an
      // input_required result asking the user, or return the portable error.
      const gate = destructiveConfirmationGate(request, ctx, server);
      if (gate !== undefined) return gate;
      try {
        const result = await handleExecute(transport, request);
        // Only batches that ran preview.render can have produced a render —
        // skip the result scan for everything else.
        const previewContent = request.operations.some((operation) => operation.name === "preview.render")
          ? await captureLatestPreview(result, previews)
          : [];
        return asToolResult(result, previewContent);
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  registerCompositorResources(server, transport, previews);
  registerWorkflowPrompts(server);

  return server;
}

/// Decides whether a batch may proceed to the bridge. Returns undefined when it
/// may (including after an accepted elicitation upgraded confirmDestructive),
/// an input_required result when the client should ask the user, or a terminal
/// error result for validation failures, declines and non-eliciting clients.
///
/// Elicitation is an additive UX affordance, never an authorization boundary:
/// the client can always set confirmDestructive itself, so a fabricated accept
/// response grants nothing the flag would not.
function destructiveConfirmationGate(
  request: ExecuteRequest,
  ctx: ServerContext,
  server: McpServer,
): CallToolResult | InputRequiredResult | undefined {
  try {
    // Light pass only — name/risk classification. Full schema validation runs
    // once in handleExecute so it never executes twice per call.
    requireDestructiveConfirmation(request, inspectRequest(request));
    return undefined;
  } catch (error) {
    if (!(error instanceof CompositorMcpError) || error.code !== "confirmation_required") {
      return errorToolResult(error);
    }

    const accepted = acceptedContent(ctx.mcpReq.inputResponses, "confirm", CONFIRM_ELICIT_SCHEMA);
    if (accepted?.confirm === true) {
      // The accepted answer upgrades the flag; handleExecute performs the
      // batch's single full validation below.
      request.confirmDestructive = true;
      return undefined;
    }

    if (ctx.mcpReq.inputResponses !== undefined) {
      // The client already answered this round (declined, cancelled, or an
      // unusable payload) — ask once, never loop.
      return errorToolResult(
        new CompositorMcpError(
          "confirmation_declined",
          "Destructive operations were not confirmed; the batch was not run. Re-run with confirmDestructive: true to proceed non-interactively.",
        ),
      );
    }

    if (!clientSupportsElicitation(ctx, server)) {
      // Portable contract: non-eliciting clients keep the flag-only path.
      return errorToolResult(error);
    }

    const operations = destructiveOperations(error, request);
    return inputRequired({
      inputRequests: {
        confirm: inputRequired.elicit({
          message: `Approve destructive Compositor operations: ${operations}? The batch runs immediately on accept.`,
          requestedSchema: CONFIRM_ELICIT_SCHEMA,
        }),
      },
    });
  }
}

/// Per-request capabilities on the 2026-era envelope; the initialize-declared
/// set on 2025-era connections. Only advertised elicitation triggers prompts.
function clientSupportsElicitation(ctx: ServerContext, server: McpServer): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const perRequest = envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
  return (perRequest ?? server.server.getClientCapabilities())?.elicitation != null;
}

/// Compact per-op digest for the confirmation prompt: each destructive op
/// rendered with the primary identifier it targets — layer.delete(layerId=…),
/// pixels.clear(path=…), and so on — so the user sees what is about to be
/// destroyed, not just which verbs run.
function destructiveOperations(error: CompositorMcpError, request: ExecuteRequest): string {
  let names: Set<string> | null = null;
  const details = error.details;
  if (isJsonObject(details)) {
    const listed = details["operations"];
    if (Array.isArray(listed) && listed.every((name) => typeof name === "string")) {
      names = new Set(listed as string[]);
    }
  }
  const digests = new Set<string>();
  for (const operation of request.operations) {
    const destructive = names === null
      ? CAPABILITY_BY_NAME.get(operation.name)?.risk === "destructive"
      : names.has(operation.name);
    if (destructive) digests.add(operationDigest(operation));
  }
  return digests.size > 0 ? [...digests].join(", ") : "the requested operations";
}

/// `name(key=value)` using the first recognised identifier argument.
function operationDigest(operation: Operation): string {
  const args = operation.arguments;
  if (isJsonObject(args)) {
    for (const key of ["layerId", "path", "id", "documentId"] as const) {
      const value = args[key];
      if (typeof value === "string" || typeof value === "number") return `${operation.name}(${key}=${value})`;
    }
  }
  return operation.name;
}

function asToolResult(value: JsonValue, extraContent: ContentBlock[] = []): CallToolResult {
  const structured = isJsonObject(value) ? value : { result: value };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }, ...extraContent],
    structuredContent: structured as Record<string, unknown>,
  };
}

function errorToolResult(error: unknown): CallToolResult {
  const normalised = normaliseError(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: normalised }, null, 2) }],
  };
}
