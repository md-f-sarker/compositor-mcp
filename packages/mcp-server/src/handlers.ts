import {
  CAPABILITY_BY_NAME,
  searchCapabilities,
  validateJsonSchema,
  type ExecuteRequest,
  type JsonObject,
  type JsonValue,
  type Operation,
} from "@compositor-mcp/protocol";
import { CompositorMcpError } from "./errors.js";
import type { BridgeTransport } from "./bridge-client.js";

export interface SearchInput {
  query: string;
  limit?: number;
  includeSchemas?: boolean;
  includePlanned?: boolean;
}

export function handleSearch(input: SearchInput): JsonValue {
  const hits = searchCapabilities(input.query, {
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.includeSchemas === undefined ? {} : { includeSchemas: input.includeSchemas }),
    ...(input.includePlanned === undefined ? {} : { includePlanned: input.includePlanned }),
  });
  return {
    query: input.query,
    count: hits.length,
    results: hits,
    hint: "Call execute with one or more implemented operation names. Use dryRun first for risky or complex batches.",
  } as unknown as JsonValue;
}

export async function handleExecute(transport: BridgeTransport, request: ExecuteRequest): Promise<JsonValue> {
  validateExecuteRequest(request);
  return transport.request("execute", request as unknown as JsonObject);
}

export function validateExecuteRequest(request: ExecuteRequest): void {
  if (!Array.isArray(request.operations) || request.operations.length === 0) {
    throw new CompositorMcpError("invalid_request", "At least one operation is required.");
  }
  if (request.operations.length > 100) {
    throw new CompositorMcpError("too_many_operations", "A batch may contain at most 100 operations.");
  }
  if (request.idempotencyKey !== undefined && (request.idempotencyKey.length < 8 || request.idempotencyKey.length > 200)) {
    throw new CompositorMcpError("invalid_idempotency_key", "idempotencyKey must be between 8 and 200 characters.");
  }

  const destructive: string[] = [];
  const nonTransactional: string[] = [];
  for (const operation of request.operations) {
    validateOperation(operation);
    const capability = CAPABILITY_BY_NAME.get(operation.name)!;
    if (capability.risk === "destructive") destructive.push(operation.name);
    if (!capability.transactional && capability.risk !== "read") nonTransactional.push(operation.name);
  }

  if (destructive.length > 0 && request.confirmDestructive !== true && request.dryRun !== true) {
    throw new CompositorMcpError(
      "confirmation_required",
      `Destructive confirmation required for: ${[...new Set(destructive)].join(", ")}. Re-run with confirmDestructive: true.`,
      { details: { destructiveOperations: [...new Set(destructive)] } },
    );
  }

  if ((request.atomic ?? true) && nonTransactional.length > 0 && request.operations.length > 1) {
    throw new CompositorMcpError(
      "non_transactional_batch",
      `Atomic batches cannot mix file/workspace operations that cannot be rolled back: ${[...new Set(nonTransactional)].join(", ")}. Split the batch or set atomic: false.`,
    );
  }
}

function validateOperation(operation: Operation): void {
  if (!operation || typeof operation !== "object" || typeof operation.name !== "string" || operation.name.length === 0) {
    throw new CompositorMcpError("invalid_operation", "Every operation must have a non-empty name.");
  }
  const capability = CAPABILITY_BY_NAME.get(operation.name);
  if (!capability) {
    throw new CompositorMcpError("unknown_operation", `Unknown operation: ${operation.name}. Use search to discover valid operations.`);
  }
  if (capability.status !== "implemented") {
    throw new CompositorMcpError("operation_not_implemented", `${operation.name} is documented for the roadmap but is not implemented in this build.`);
  }
  if (operation.arguments !== undefined && (typeof operation.arguments !== "object" || operation.arguments === null || Array.isArray(operation.arguments))) {
    throw new CompositorMcpError("invalid_arguments", `${operation.name}.arguments must be an object.`);
  }

  const issues = validateJsonSchema(capability.inputSchema, operation.arguments ?? {});
  if (issues.length > 0) {
    throw new CompositorMcpError(
      "invalid_arguments",
      `${operation.name} arguments do not match its schema: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
      { details: { operation: operation.name, issues: issues as unknown as JsonValue } },
    );
  }
}
