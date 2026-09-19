export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type CapabilityRisk = "read" | "write" | "destructive" | "filesystem";
export type CapabilityStatus = "implemented" | "planned";

export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: JsonPrimitive[];
  const?: JsonPrimitive;
  default?: JsonValue;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  examples?: JsonValue[];
}

export interface Capability {
  name: string;
  title: string;
  description: string;
  category: string;
  risk: CapabilityRisk;
  status: CapabilityStatus;
  transactional: boolean;
  aliases: string[];
  tags: string[];
  inputSchema: JsonSchema;
  examples: Array<{ arguments: JsonObject; note?: string }>;
}

export interface OperationPrecondition {
  projectId?: string;
  documentId?: string;
  revision?: number;
}

export interface Operation {
  name: string;
  arguments?: JsonObject;
  precondition?: OperationPrecondition;
}

export interface ExecuteRequest {
  operations: Operation[];
  atomic?: boolean;
  dryRun?: boolean;
  confirmDestructive?: boolean;
  idempotencyKey?: string;
}

export interface OperationResult {
  index: number;
  name: string;
  ok: boolean;
  value?: JsonValue;
  error?: BridgeErrorShape;
}

export interface ExecuteResult {
  ok: boolean;
  dryRun: boolean;
  atomic: boolean;
  rolledBack?: boolean;
  mutated?: boolean;
  revision?: number;
  results: OperationResult[];
  state?: JsonValue;
}

export interface BridgeDiscovery {
  protocol: "compositor-bridge/1";
  host: string;
  port: number;
  token: string;
  pid: number;
  startedAt: string;
  appVersion?: string;
}

export interface BridgeRequest {
  protocol: "compositor-bridge/1";
  id: string;
  token: string;
  method: "ping" | "state" | "execute" | "capabilities";
  params?: JsonObject;
}

export interface BridgeErrorShape {
  code: string;
  message: string;
  details?: JsonValue;
  retryable?: boolean;
}

export interface BridgeResponse {
  protocol: "compositor-bridge/1";
  id: string;
  ok: boolean;
  result?: JsonValue;
  error?: BridgeErrorShape;
}

export interface SearchOptions {
  limit?: number;
  includeSchemas?: boolean;
  includePlanned?: boolean;
}

export interface CapabilitySearchHit {
  score: number;
  capability: Capability | Omit<Capability, "inputSchema" | "examples">;
}
