import type { JsonObject, JsonSchema, JsonValue } from "./types.js";

export interface SchemaValidationIssue {
  path: string;
  message: string;
}

/// A non-null, non-array JSON object — the guard the server, mock bridge and
/// CLI all use to recognise record-shaped values.
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateJsonSchema(
  schema: JsonSchema,
  value: unknown,
  path = "$",
): SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = [];
  validateInto(schema, value, path, issues);
  return issues;
}

/// Recursive worker: appends findings to the shared `issues` accumulator so a
/// deep document never allocates or spreads a fresh array per node.
function validateInto(
  schema: JsonSchema,
  value: unknown,
  path: string,
  issues: SchemaValidationIssue[],
): void {
  if (schema.oneOf) {
    // Bail at the second match: the count only has to distinguish 0, 1 and
    // "ambiguous", and catalogues with const-keyed branches can never reach 2.
    let matches = 0;
    for (const candidate of schema.oneOf) {
      if (validateJsonSchema(candidate, value, path).length === 0) {
        matches += 1;
        if (matches === 2) break;
      }
    }
    if (matches !== 1) {
      issues.push({ path, message: `must match exactly one schema (matched ${matches})` });
      return;
    }
  }
  if (schema.anyOf && !schema.anyOf.some((candidate) => validateJsonSchema(candidate, value, path).length === 0)) {
    issues.push({ path, message: "must match at least one schema" });
    return;
  }

  if (schema.const !== undefined && !jsonEqual(value, schema.const)) {
    issues.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum && !schema.enum.some((candidate) => jsonEqual(value, candidate))) {
    issues.push({ path, message: `must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}` });
  }

  const expectedTypes = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (expectedTypes.length > 0 && !expectedTypes.some((type) => matchesType(type, value))) {
    issues.push({ path, message: `must be ${expectedTypes.join(" or ")}` });
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) issues.push({ path, message: "must be finite" });
    if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path, message: `must be at least ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path, message: `must be at most ${schema.maximum}` });
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push({ path, message: `must contain at least ${schema.minLength} characters` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push({ path, message: `must contain at most ${schema.maxLength} characters` });
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) issues.push({ path, message: `must match ${schema.pattern}` });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push({ path, message: `must contain at least ${schema.minItems} items` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push({ path, message: `must contain at most ${schema.maxItems} items` });
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        validateInto(schema.items, value[index], `${path}[${index}]`, issues);
      }
    }
  }

  if (isJsonObject(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!(required in value)) issues.push({ path: `${path}.${required}`, message: "is required" });
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (childSchema) {
        validateInto(childSchema, child, `${path}.${key}`, issues);
      } else if (schema.additionalProperties === false) {
        issues.push({ path: `${path}.${key}`, message: "is not allowed" });
      } else if (typeof schema.additionalProperties === "object") {
        validateInto(schema.additionalProperties, child, `${path}.${key}`, issues);
      }
    }
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "array": return Array.isArray(value);
    case "object": return isJsonObject(value);
    default: return false;
  }
}

function jsonEqual(left: unknown, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
