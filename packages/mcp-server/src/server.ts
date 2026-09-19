import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ExecuteRequest, JsonValue } from "@compositor-mcp/protocol";
import type { BridgeTransport } from "./bridge-client.js";
import { normaliseError } from "./errors.js";
import { handleExecute, handleSearch } from "./handlers.js";

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

export function createCompositorMcpServer(transport: BridgeTransport): McpServer {
  const server = new McpServer({
    name: "compositor-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "search",
    {
      description:
        "Search Compositor's capability catalogue using natural language. Returns operation names, risk, implementation status and JSON schemas without loading the whole catalogue into context.",
      inputSchema: z.object({
        query: z.string().default(""),
        limit: z.number().int().min(1).max(50).default(10),
        includeSchemas: z.boolean().default(true),
        includePlanned: z.boolean().default(false),
      }),
    },
    async (input) => asToolResult(handleSearch(input)),
  );

  server.registerTool(
    "execute",
    {
      description:
        "Execute one or more typed Compositor operations. Supports dry-run validation, optimistic preconditions, undo-grouped atomic batches, idempotency keys and explicit confirmation for destructive edits.",
      inputSchema: z.object({
        operations: z.array(operationSchema).min(1).max(100),
        atomic: z.boolean().default(true),
        dryRun: z.boolean().default(false),
        confirmDestructive: z.boolean().default(false),
        idempotencyKey: z.string().min(8).max(200).optional(),
      }),
    },
    async (input) => {
      try {
        const result = await handleExecute(transport, input as ExecuteRequest);
        return asToolResult(result);
      } catch (error) {
        const normalised = normaliseError(error);
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: normalised }, null, 2) }],
        };
      }
    },
  );

  return server;
}

function asToolResult(value: JsonValue): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
