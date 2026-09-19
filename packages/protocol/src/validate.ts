import type { JsonSchema, JsonValue } from "./types.js";

export interface SchemaValidationIssue {
  path: string;
  message: string;
}

export function validateJsonSchema(
  schema: JsonSchema,
  value: unknown,
  path = "$",
): SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = [];

  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => validateJsonSchema(candidate, value, path).length === 0).length;
    if (matches !== 1) {
      issues.push({ path, message: `must match exactly one schema (matched ${matches})` });
      return issues;
    }
  }
  if (schema.anyOf && !schema.anyOf.some((candidate) => validateJsonSchema(candidate, value, path).length === 0)) {
    issues.push({ path, message: "must match at least one schema" });
    return issues;
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
    return issues;
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
        issues.push(...validateJsonSchema(schema.items, value[index], `${path}[${index}]`));
      }
    }
  }

  if (isRecord(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!(required in value)) issues.push({ path: `${path}.${required}`, message: "is required" });
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (childSchema) {
        issues.push(...validateJsonSchema(childSchema, child, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        issues.push({ path: `${path}.${key}`, message: "is not allowed" });
      } else if (typeof schema.additionalProperties === "object") {
        issues.push(...validateJsonSchema(schema.additionalProperties, child, `${path}.${key}`));
      }
    }
  }

  return issues;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "array": return Array.isArray(value);
    case "object": return isRecord(value);
    default: return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
