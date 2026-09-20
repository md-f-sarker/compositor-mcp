import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { CAPABILITY_BY_NAME, validateJsonSchema } from "@compositor-mcp/protocol";
import type { JsonObject, JsonValue } from "@compositor-mcp/protocol";
import type { BridgeTransport } from "../src/bridge-client.js";
import { SocketBridgeTransport } from "../src/bridge-client.js";
import { MockBridgeTransport } from "../src/mock-bridge.js";
import { assertImplementedOperation, renderWorkflow, WORKFLOW_PROMPTS } from "../src/prompts.js";
import { INLINE_PREVIEW_MAX_BYTES } from "../src/resources.js";
import { createCompositorMcpServer } from "../src/server.js";

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface TestClientOptions {
  capabilities?: Record<string, unknown>;
  protocolVersion?: string;
  onServerRequest?: (message: { id: unknown; method: string; params?: unknown }, reply: (result: unknown) => void) => void;
}

/// Minimal raw JSON-RPC client over the SDK's linked in-memory transports:
/// exercises tools, resources, prompts and server→client requests (the legacy
/// elicitation shim) exactly as they appear on the wire.
async function createTestClient(bridge: BridgeTransport, options: TestClientOptions = {}) {
  const server = createCompositorMcpServer(bridge);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map<unknown, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  let nextId = 1;

  clientTransport.onmessage = (message) => {
    if (typeof message !== "object" || message === null) return;
    const envelope = message as { id?: unknown; method?: string; params?: unknown; result?: unknown; error?: RpcError };
    if (envelope.method !== undefined && envelope.id !== undefined) {
      // A server→client request (e.g. the legacy-shim's elicitation/create).
      options.onServerRequest?.({ id: envelope.id, method: envelope.method, params: envelope.params }, (result) => {
        void clientTransport.send({ jsonrpc: "2.0", id: envelope.id as string, result });
      });
      return;
    }
    if (envelope.method !== undefined || envelope.id === undefined) return; // notification
    const entry = pending.get(envelope.id);
    if (!entry) return;
    pending.delete(envelope.id);
    if (envelope.error) {
      entry.reject(Object.assign(new Error(envelope.error.message), { rpcError: envelope.error }));
    } else {
      entry.resolve(envelope.result as never);
    }
  };

  await server.connect(serverTransport);
  await clientTransport.start();

  const request = <T>(method: string, params?: unknown): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve: resolve as (value: never) => void, reject });
      void clientTransport.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });

  await request("initialize", {
    protocolVersion: options.protocolVersion ?? "2025-11-25",
    capabilities: options.capabilities ?? {},
    clientInfo: { name: "mcp-server-test", version: "0.0.0" },
  });
  void clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  return { request, server, clientTransport };
}

interface ToolListEntry {
  name: string;
  description?: string;
  annotations?: Record<string, unknown>;
  outputSchema?: JsonObject;
}

interface CallToolResultShape {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const createDocument = { name: "document.create", arguments: { width: 64, height: 64 } };

test("tools/list exposes exactly search and execute with annotations and output schemas", async () => {
  const { request } = await createTestClient(new MockBridgeTransport());
  const { tools } = await request<{ tools: ToolListEntry[] }>("tools/list");

  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["execute", "search"]);
  const search = tools.find((tool) => tool.name === "search")!;
  const execute = tools.find((tool) => tool.name === "execute")!;

  assert.equal(search.annotations?.["readOnlyHint"], true);
  assert.equal(execute.annotations?.["destructiveHint"], true);
  // Batches can mutate — execute must not claim idempotence.
  assert.equal(execute.annotations?.["idempotentHint"], false);

  assert.ok(search.outputSchema, "search declares an outputSchema");
  assert.ok(execute.outputSchema, "execute declares an outputSchema");
});

test("execute output schema covers the batch/atomic envelope (dry-run, rollback fields)", async () => {
  const { request } = await createTestClient(new MockBridgeTransport());
  const { tools } = await request<{ tools: ToolListEntry[] }>("tools/list");
  const schema = tools.find((tool) => tool.name === "execute")!.outputSchema!;
  const properties = schema["properties"] as Record<string, unknown>;

  for (const field of ["ok", "results", "state", "revision", "rolledBack", "dryRun", "atomic", "mutated"]) {
    assert.ok(field in properties, `execute outputSchema declares ${field}`);
  }
});

test("execute returns structuredContent matching its declared output schema, with text content", async () => {
  const { request } = await createTestClient(new MockBridgeTransport());
  const { tools } = await request<{ tools: ToolListEntry[] }>("tools/list");
  const schema = tools.find((tool) => tool.name === "execute")!.outputSchema!;

  const result = await request<CallToolResultShape>("tools/call", {
    name: "execute",
    arguments: { operations: [createDocument] },
  });

  assert.ok(result.structuredContent, "structuredContent present");
  assert.equal(result.structuredContent["ok"], true);
  assert.equal(result.content?.[0]?.type, "text");
  const parsed = JSON.parse(result.content![0]!.text!) as Record<string, unknown>;
  assert.equal(parsed["ok"], true);
  assert.deepEqual(validateJsonSchema(schema, result.structuredContent as JsonValue), []);
});

test("search returns structuredContent with a hits array, with text content", async () => {
  const { request } = await createTestClient(new MockBridgeTransport());
  const result = await request<CallToolResultShape>("tools/call", {
    name: "search",
    arguments: { query: "opacity" },
  });

  assert.equal(result.content?.[0]?.type, "text");
  assert.ok(Array.isArray(result.structuredContent?.["results"]), "structured hits array present");
  assert.equal(result.structuredContent?.["count"], (result.structuredContent?.["results"] as unknown[]).length);
});

test("compositor://state returns the same shape as app.getState", async () => {
  const bridge = new MockBridgeTransport();
  const { request } = await createTestClient(bridge);
  await request("tools/call", { name: "execute", arguments: { operations: [createDocument] } });

  const expected = (await bridge.request("state")) as Record<string, unknown>;
  const read = await request<{ contents: Array<{ uri: string; mimeType?: string; text?: string }> }>("resources/read", {
    uri: "compositor://state",
  });

  assert.equal(read.contents[0]?.mimeType, "application/json");
  assert.deepEqual(JSON.parse(read.contents[0]!.text!), expected);
});

test("compositor://layers flattens the layer tree out of state", async () => {
  const { request } = await createTestClient(new MockBridgeTransport());
  await request("tools/call", { name: "execute", arguments: { operations: [createDocument] } });
  await request("tools/call", {
    name: "execute",
    arguments: { operations: [{ name: "layer.addBlank", arguments: { name: "Retouch" } }] },
  });

  const read = await request<{ contents: Array<{ text?: string }> }>("resources/read", { uri: "compositor://layers" });
  const tree = JSON.parse(read.contents[0]!.text!) as { layers: Array<{ name: string }> };
  assert.ok(Array.isArray(tree.layers));
  assert.ok(tree.layers.some((layer) => layer.name === "Retouch"));
});

test("compositor://capabilities serves the catalogue", async () => {
  const { request } = await createTestClient(new MockBridgeTransport());
  const read = await request<{ contents: Array<{ text?: string }> }>("resources/read", { uri: "compositor://capabilities" });
  const envelope = JSON.parse(read.contents[0]!.text!) as {
    protocol?: string;
    implemented?: string[];
    catalogue?: Array<{ name: string }>;
  };
  assert.equal(envelope.protocol, "compositor-bridge/1");
  assert.equal(envelope.implemented?.length, CAPABILITY_BY_NAME.size);
  assert.ok(envelope.catalogue?.some((entry) => entry.name === "preview.render"));
});

test("preview.render caches bytes for compositor://preview/latest and inlines the image", async () => {
  const { request } = await createTestClient(new MockBridgeTransport());

  // Before any render the resource answers with plain-text guidance.
  const early = await request<{ contents: Array<{ mimeType?: string; text?: string; blob?: string }> }>("resources/read", {
    uri: "compositor://preview/latest",
  });
  assert.equal(early.contents[0]?.mimeType, "text/plain");
  assert.match(early.contents[0]!.text!, /preview\.render/);

  await request("tools/call", { name: "execute", arguments: { operations: [createDocument] } });
  const rendered = await request<CallToolResultShape>("tools/call", {
    name: "execute",
    arguments: { operations: [{ name: "preview.render" }] },
  });

  const image = rendered.content?.find((block) => block.type === "image");
  assert.ok(image, "execute result carries an inline image block");
  assert.equal(image!.mimeType, "image/png");
  const pathResult = JSON.parse(rendered.content![0]!.text!) as { results: Array<{ value: { path: string } }> };
  assert.match(pathResult.results[0]!.value.path, /preview-.+\.png$/);

  const latest = await request<{ contents: Array<{ uri: string; mimeType?: string; blob?: string }> }>("resources/read", {
    uri: "compositor://preview/latest",
  });
  assert.equal(latest.contents[0]?.mimeType, "image/png");
  assert.equal(latest.contents[0]?.blob, image!.data);
  const png = Buffer.from(latest.contents[0]!.blob!, "base64");
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test("previews over 1 MiB stay path-only but still fill the latest resource", async () => {
  const bigPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(INLINE_PREVIEW_MAX_BYTES)]);
  const { request } = await createTestClient(new MockBridgeTransport({ previewImage: bigPng }));
  await request("tools/call", { name: "execute", arguments: { operations: [createDocument] } });
  const rendered = await request<CallToolResultShape>("tools/call", {
    name: "execute",
    arguments: { operations: [{ name: "preview.render" }] },
  });

  assert.equal(rendered.content?.some((block) => block.type === "image"), false);
  const latest = await request<{ contents: Array<{ blob?: string }> }>("resources/read", { uri: "compositor://preview/latest" });
  assert.equal(Buffer.from(latest.contents[0]!.blob!, "base64").length, bigPng.length);
});

test("resource reads without a bridge surface the retryable bridge_not_running error", async () => {
  const transport = new SocketBridgeTransport({ discoveryPath: "/nonexistent/compositor-mcp/bridge.json" });
  const { request } = await createTestClient(transport);

  await assert.rejects(
    request("resources/read", { uri: "compositor://state" }),
    (error: unknown) => {
      const rpcError = (error as { rpcError?: RpcError }).rpcError;
      const data = rpcError?.data as { code?: string; retryable?: boolean } | undefined;
      assert.equal(data?.code, "bridge_not_running");
      assert.equal(data?.retryable, true);
      return true;
    },
  );
});

test("tools work for clients that declare no resource or prompt support", async () => {
  const { request } = await createTestClient(new MockBridgeTransport(), { capabilities: {} });
  const result = await request<CallToolResultShape>("tools/call", {
    name: "execute",
    arguments: { operations: [createDocument] },
  });
  assert.equal(result.structuredContent?.["ok"], true);
  const search = await request<CallToolResultShape>("tools/call", { name: "search", arguments: { query: "layer" } });
  assert.equal(search.isError, undefined);
});

test("prompts/list and prompts/get serve the workflow recipes", async () => {
  const { request } = await createTestClient(new MockBridgeTransport());
  const { prompts } = await request<{ prompts: Array<{ name: string }> }>("prompts/list");
  assert.deepEqual(
    prompts.map((prompt) => prompt.name).sort(),
    [...WORKFLOW_PROMPTS.map((prompt) => prompt.name)].sort(),
  );

  const got = await request<{ description?: string; messages: Array<{ role: string; content: { type: string; text: string } }> }>(
    "prompts/get",
    { name: "export-for-web", arguments: { width: "1600", outputDirectory: "/tmp/exports" } },
  );
  const text = got.messages[0]!.content.text;
  assert.match(text, /document\.export/);
  assert.match(text, /document\.resizeImage/);
  assert.match(text, /1600/);
});

test("every workflow prompt names only implemented catalogue operations", () => {
  const operationToken = /\b(?:app|workspace|document|history|layer|selection|pixels|paint|adjustment|filter|preview)\.[a-zA-Z]+\b/g;
  for (const prompt of WORKFLOW_PROMPTS) {
    const text = renderWorkflow(prompt, {});
    for (const token of text.match(operationToken) ?? []) {
      const capability = CAPABILITY_BY_NAME.get(token);
      assert.ok(capability, `${prompt.name} references unknown operation ${token}`);
      assert.equal(capability.status, "implemented", `${prompt.name} references non-implemented operation ${token}`);
    }
  }
});

test("prompt registration fails loudly if a workflow ever names a bad operation", () => {
  // registerWorkflowPrompts runs the same assertion at startup.
  for (const prompt of WORKFLOW_PROMPTS) {
    for (const step of prompt.build({}).steps) {
      assertImplementedOperation(prompt.name, step.operation);
    }
  }
});

test("destructive execute elicits confirmation when the client advertises elicitation", async () => {
  let elicitations = 0;
  const { request } = await createTestClient(new MockBridgeTransport(), {
    capabilities: { elicitation: {} },
    onServerRequest: (message, reply) => {
      if (message.method === "elicitation/create") {
        elicitations += 1;
        reply({ action: "accept", content: { confirm: true } });
      }
    },
  });
  await request("tools/call", { name: "execute", arguments: { operations: [createDocument] } });
  await request("tools/call", { name: "execute", arguments: { operations: [{ name: "layer.addBlank", arguments: {} }] } });

  const result = await request<CallToolResultShape>("tools/call", {
    name: "execute",
    arguments: { operations: [{ name: "layer.delete", arguments: { layerId: "active" } }] },
  });

  assert.equal(elicitations, 1);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent?.["ok"], true);
});

test("declined elicitation fails the batch; non-eliciting clients keep the flag-only error", async () => {
  const declined = await createTestClient(new MockBridgeTransport(), {
    capabilities: { elicitation: {} },
    onServerRequest: (message, reply) => {
      if (message.method === "elicitation/create") reply({ action: "decline" });
    },
  });
  const declinedResult = await declined.request<CallToolResultShape>("tools/call", {
    name: "execute",
    arguments: { operations: [{ name: "layer.delete", arguments: { layerId: "active" } }] },
  });
  assert.equal(declinedResult.isError, true);
  assert.match(declinedResult.content![0]!.text!, /not confirmed|confirmDestructive/i);

  const plain = await createTestClient(new MockBridgeTransport());
  const plainResult = await plain.request<CallToolResultShape>("tools/call", {
    name: "execute",
    arguments: { operations: [{ name: "layer.delete", arguments: { layerId: "active" } }] },
  });
  assert.equal(plainResult.isError, true);
  assert.match(plainResult.content![0]!.text!, /confirmation_required/);
});

test("confirmDestructive: true remains the portable non-interactive contract", async () => {
  const { request } = await createTestClient(new MockBridgeTransport());
  await request("tools/call", { name: "execute", arguments: { operations: [createDocument] } });
  await request("tools/call", { name: "execute", arguments: { operations: [{ name: "layer.addBlank", arguments: {} }] } });
  const result = await request<CallToolResultShape>("tools/call", {
    name: "execute",
    arguments: { confirmDestructive: true, operations: [{ name: "layer.delete", arguments: { layerId: "active" } }] },
  });
  assert.equal(result.structuredContent?.["ok"], true);
});

test("execute errors keep isError plus a JSON error payload", async () => {
  const { request } = await createTestClient(new MockBridgeTransport());
  const result = await request<CallToolResultShape>("tools/call", {
    name: "execute",
    arguments: { operations: [{ name: "pixels.teleport", arguments: {} }] },
  });
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content![0]!.text!) as { ok: boolean; error: { code: string } };
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "unknown_operation");
});
