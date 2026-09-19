import assert from "node:assert/strict";
import test from "node:test";
import type { ExecuteRequest } from "@compositor-mcp/protocol";
import { handleExecute, handleSearch, validateExecuteRequest } from "../src/handlers.js";
import { MockBridgeTransport } from "../src/mock-bridge.js";

test("search finds opacity", () => {
  const result = handleSearch({ query: "make active layer half transparent", limit: 5 });
  const text = JSON.stringify(result);
  assert.match(text, /layer\.setOpacity/);
});

test("destructive operations require explicit confirmation", () => {
  assert.throws(
    () => validateExecuteRequest({ operations: [{ name: "layer.delete", arguments: { layerId: "active" } }] }),
    /confirmation/i,
  );
});

test("planned operations are rejected", () => {
  assert.throws(
    () => validateExecuteRequest({ operations: [{ name: "paint.brushStroke", arguments: {} }], dryRun: true }),
    /not implemented/i,
  );
});

test("mock bridge performs an atomic editing batch", async () => {
  const bridge = new MockBridgeTransport();
  const request: ExecuteRequest = {
    atomic: true,
    operations: [
      { name: "document.create", arguments: { width: 1200, height: 800 } },
    ],
  };
  await handleExecute(bridge, request);

  const second = (await handleExecute(bridge, {
    atomic: true,
    operations: [
      { name: "layer.addBlank", arguments: { name: "Retouch" } },
      { name: "layer.setOpacity", arguments: { layerId: "active", opacity: 0.5 } },
    ],
  })) as Record<string, unknown>;

  assert.equal(second.ok, true);
  assert.match(JSON.stringify(second), /Retouch/);
  assert.match(JSON.stringify(second), /0\.5/);
});

test("operation arguments are checked against the capability schema", () => {
  assert.throws(
    () => validateExecuteRequest({ operations: [{ name: "layer.setOpacity", arguments: { opacity: 2 } }] }),
    /layerId.*required.*opacity.*at most 1/i,
  );
  assert.throws(
    () => validateExecuteRequest({ operations: [{ name: "layer.setBlendMode", arguments: { layerId: "active", blendMode: "Imaginary" } }] }),
    /must be one of/i,
  );
  assert.throws(
    () => validateExecuteRequest({ operations: [{ name: "app.ping", arguments: { unexpected: true } }] }),
    /not allowed/i,
  );
});
