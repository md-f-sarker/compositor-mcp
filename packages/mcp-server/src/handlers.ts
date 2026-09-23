import {
  CAPABILITY_BY_NAME,
  countCapabilityMatches,
  isJsonObject,
  searchCapabilities,
  validateJsonSchema,
  type Capability,
  type ExecuteRequest,
  type JsonObject,
  type JsonValue,
  type Operation,
  type SearchOptions,
} from "@compositor-mcp/protocol";
import { CompositorMcpError } from "./errors.js";
import type { BridgeTransport } from "./bridge-client.js";

export interface SearchInput extends SearchOptions {
  query: string;
}

export function handleSearch(input: SearchInput): JsonValue {
  // The catalogue can exceed the 50-hit fetch cap, so `total` comes from an
  // unclamped count — otherwise it would silently under-report matches.
  const limit = Math.max(1, Math.min(50, input.limit ?? 10));
  const results = searchCapabilities(input.query, { ...input, limit });
  const total = countCapabilityMatches(input.query, input);
  return {
    query: input.query,
    count: results.length,
    total,
    truncated: results.length < total,
    results,
    hint: "Call execute with one or more implemented operation names. Use dryRun first for risky or complex batches.",
  } as unknown as JsonValue;
}

export async function handleExecute(transport: BridgeTransport, request: ExecuteRequest): Promise<JsonValue> {
  validateExecuteRequest(request);
  return transport.request("execute", request as unknown as JsonObject);
}

/// The batch's risk classification — operation names resolved against the
/// catalogue with no per-argument schema validation. The destructive gate in
/// server.ts runs this light pass so elicitation never waits on the schema
/// walk; handleExecute still validates every operation fully.
export interface RequestInspection {
  /** Names of destructive operations in the batch, in encounter order. */
  destructive: string[];
  /** Names of non-transactional, non-read operations in the batch, in encounter order. */
  nonTransactional: string[];
}

export function inspectRequest(request: ExecuteRequest): RequestInspection {
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
    const capability = inspectOperation(operation);
    if (capability.risk === "destructive") destructive.push(operation.name);
    if (!capability.transactional && capability.risk !== "read") nonTransactional.push(operation.name);
  }
  return { destructive, nonTransactional };
}

/// Throws confirmation_required for an unconfirmed destructive batch — the
/// destructive gate's half of request validation. `details.operations` matches
/// the key the Swift router emits for the same code.
export function requireDestructiveConfirmation(request: ExecuteRequest, inspection: RequestInspection): void {
  if (inspection.destructive.length > 0 && request.confirmDestructive !== true && request.dryRun !== true) {
    const operations = [...new Set(inspection.destructive)];
    throw new CompositorMcpError(
      "confirmation_required",
      `Destructive confirmation required for: ${operations.join(", ")}. Re-run with confirmDestructive: true.`,
      { details: { operations } },
    );
  }
}

export function validateExecuteRequest(request: ExecuteRequest): void {
  const inspection = inspectRequest(request);
  for (const operation of request.operations) {
    validateArguments(operation);
  }
  requireDestructiveConfirmation(request, inspection);

  if ((request.atomic ?? true) && inspection.nonTransactional.length > 0 && request.operations.length > 1) {
    const operations = [...new Set(inspection.nonTransactional)];
    throw new CompositorMcpError(
      "non_transactional_batch",
      `Atomic batches cannot mix file/workspace operations that cannot be rolled back: ${operations.join(", ")}. Split the batch or set atomic: false.`,
      { details: { operations } },
    );
  }
}

/// Name-level checks only — shape, known operation, implemented status — so the
/// destructive gate can inspect a batch without running per-argument schemas.
function inspectOperation(operation: Operation): Capability {
  if (!isJsonObject(operation) || typeof operation.name !== "string" || operation.name.length === 0) {
    throw new CompositorMcpError("invalid_operation", "Every operation must have a non-empty name.");
  }
  const capability = CAPABILITY_BY_NAME.get(operation.name);
  if (!capability) {
    throw new CompositorMcpError("unknown_operation", `Unknown operation: ${operation.name}. Use search to discover valid operations.`);
  }
  if (capability.status !== "implemented") {
    throw new CompositorMcpError("operation_not_implemented", `${operation.name} is documented for the roadmap but is not implemented in this build.`);
  }
  if (operation.arguments !== undefined && !isJsonObject(operation.arguments)) {
    throw new CompositorMcpError("invalid_arguments", `${operation.name}.arguments must be an object.`);
  }
  return capability;
}

/// The per-operation JSON Schema check; always preceded by inspectOperation's
/// name validation inside validateExecuteRequest.
function validateArguments(operation: Operation): void {
  const capability = CAPABILITY_BY_NAME.get(operation.name)!;
  const issues = validateJsonSchema(capability.inputSchema, operation.arguments ?? {});
  if (issues.length > 0) {
    throw new CompositorMcpError(
      "invalid_arguments",
      `${operation.name} arguments do not match its schema: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
      { details: { operation: operation.name, issues: issues as unknown as JsonValue } },
    );
  }
}
