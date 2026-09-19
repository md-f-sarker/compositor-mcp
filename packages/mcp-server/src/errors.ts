import type { BridgeErrorShape, JsonValue } from "@compositor-mcp/protocol";

export class CompositorMcpError extends Error {
  readonly code: string;
  readonly details: JsonValue | undefined;
  readonly retryable: boolean;

  constructor(code: string, message: string, options: { details?: JsonValue; retryable?: boolean } = {}) {
    super(message);
    this.name = "CompositorMcpError";
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }

  toJSON(): BridgeErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
      ...(this.retryable ? { retryable: true } : {}),
    };
  }
}

export function normaliseError(error: unknown): BridgeErrorShape {
  if (error instanceof CompositorMcpError) return error.toJSON();
  if (error instanceof Error) return { code: "internal_error", message: error.message };
  return { code: "internal_error", message: String(error) };
}
