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
import type { ExecuteRequest, JsonValue } from "@compositor-mcp/protocol";
import type { BridgeTransport } from "./bridge-client.js";
import { CompositorMcpError, normaliseError } from "./errors.js";
import { handleExecute, handleSearch, validateExecuteRequest } from "./handlers.js";
import { registerWorkflowPrompts } from "./prompts.js";
import { PreviewCache, captureLatestPreview, registerCompositorResources } from "./resources.js";

const jsonObjectSchema = z.record(z.string(), z.unknown());

const operationSchema = z.object({
  name: z.string().min(1),
  arguments: jsonObjectSchema.optional(),
  precondition: z
    .object({
      projectId: z.string().optional(),
      documentId: z.string().optional(),
      revision: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

/// Advertised on tools/list and enforced by the SDK: every search hit carries
/// the catalogue fields the summary and full forms share; inputSchema/examples
/// ride along as loose extras when includeSchemas is on.
const searchOutputSchema = z.looseObject({
  query: z.string(),
  count: z.number().int().nonnegative(),
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

export function createCompositorMcpServer(transport: BridgeTransport): McpServer {
  const server = new McpServer({
    name: "compositor-mcp",
    version: "0.1.0",
  });
  const previews = new PreviewCache();

  server.registerTool(
    "search",
    {
      title: "Search capabilities",
      description:
        "Search Compositor's capability catalogue using natural language. Returns operation names, risk, implementation status and JSON schemas without loading the whole catalogue into context.",
      inputSchema: z.object({
        query: z.string().default(""),
        limit: z.number().int().min(1).max(50).default(10),
        includeSchemas: z.boolean().default(true),
        includePlanned: z.boolean().default(false),
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
        operations: z.array(operationSchema).min(1).max(100),
        atomic: z.boolean().default(true),
        dryRun: z.boolean().default(false),
        confirmDestructive: z.boolean().default(false),
        idempotencyKey: z.string().min(8).max(200).optional(),
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
        return asToolResult(result, await captureLatestPreview(result, previews));
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
    validateExecuteRequest(request);
    return undefined;
  } catch (error) {
    if (!(error instanceof CompositorMcpError) || error.code !== "confirmation_required") {
      return errorToolResult(error);
    }

    const accepted = acceptedContent(ctx.mcpReq.inputResponses, "confirm", CONFIRM_ELICIT_SCHEMA);
    if (accepted?.confirm === true) {
      request.confirmDestructive = true;
      try {
        validateExecuteRequest(request);
        return undefined;
      } catch (second) {
        return errorToolResult(second);
      }
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

    const operations = destructiveOperations(error);
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

function destructiveOperations(error: CompositorMcpError): string {
  const details = error.details;
  if (typeof details === "object" && details !== null && !Array.isArray(details)) {
    const names = (details as Record<string, JsonValue>)["destructiveOperations"];
    if (Array.isArray(names) && names.every((name) => typeof name === "string")) return names.join(", ");
  }
  return "the requested operations";
}

function asToolResult(value: JsonValue, extraContent: ContentBlock[] = []): CallToolResult {
  const structured = typeof value === "object" && value !== null && !Array.isArray(value) ? value : { result: value };
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
