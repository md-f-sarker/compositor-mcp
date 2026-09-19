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

interface MockState {
  current: {
    width: number;
    height: number;
    resolution: number;
    layers: Array<{ id: string; parentId: string | null; group: boolean; mask: boolean; transform: { x: number; y: number; width: number; height: number } }>;
    selectedLayerIds: string[];
  } | null;
}

const execute = async (bridge: MockBridgeTransport, request: ExecuteRequest) =>
  (await handleExecute(bridge, request)) as { ok: boolean; rolledBack?: boolean; results: Array<{ ok: boolean; error?: { code: string } }>; state: MockState };

const createDocument = async (bridge: MockBridgeTransport, width = 1200, height = 800) => {
  await handleExecute(bridge, { operations: [{ name: "document.create", arguments: { width, height } }] });
};

test("document.crop shrinks the canvas to the rect", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  const result = await execute(bridge, {
    operations: [{ name: "document.crop", arguments: { x: 64, y: 64, width: 512, height: 512 } }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.current?.width, 512);
  assert.equal(result.state.current?.height, 512);
});

test("document.crop rejects a fully outside rect", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  const result = await execute(bridge, {
    operations: [{ name: "document.crop", arguments: { x: 5000, y: 5000, width: 512, height: 512 } }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.results[0]?.error?.code, "invalid_arguments");
  assert.equal(result.state.current?.width, 1200);
});

test("document.resizeCanvas anchored top-left grows right/bottom without moving pixels", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  await handleExecute(bridge, { operations: [{ name: "layer.addBlank", arguments: { name: "Art" } }] });
  const result = await execute(bridge, {
    operations: [{ name: "document.resizeCanvas", arguments: { width: 1920, height: 1080, anchor: "top-left" } }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.current?.width, 1920);
  assert.equal(result.state.current?.height, 1080);
  const layer = result.state.current?.layers[0];
  assert.equal(layer?.transform.x, 0);
  assert.equal(layer?.transform.y, 0);
});

test("document.resizeImage resamples the whole document and rejects >30,000 px", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  const result = await execute(bridge, {
    operations: [{ name: "document.resizeImage", arguments: { width: 600, height: 400, resolution: 144 } }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.current?.width, 600);
  assert.equal(result.state.current?.resolution, 144);
  assert.throws(
    () => validateExecuteRequest({ operations: [{ name: "document.resizeImage", arguments: { width: 31000, height: 100 } }] }),
    /at most 30000/i,
  );
});

test("layer.ungroup dissolves a two-layer group preserving order", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  await handleExecute(bridge, { operations: [{ name: "layer.addBlank", arguments: { name: "A" } }] });
  const withTwo = await execute(bridge, { operations: [{ name: "layer.addBlank", arguments: { name: "B" } }] });
  const ids = (withTwo.state.current?.layers ?? []).map((layer) => layer.id);
  assert.equal(ids.length, 2);
  const grouped = await execute(bridge, {
    operations: [
      { name: "layer.select", arguments: { layerIds: ids } },
      { name: "layer.group", arguments: { name: "Pair" } },
    ],
  });
  assert.equal(grouped.ok, true);
  assert.equal(grouped.state.current?.layers.some((layer) => layer.group), true);
  const result = await execute(bridge, { operations: [{ name: "layer.ungroup", arguments: { layerId: "active" } }] });
  assert.equal(result.ok, true);
  const layers = result.state.current?.layers ?? [];
  assert.equal(layers.some((layer) => layer.group), false);
  assert.deepEqual(layers.map((layer) => layer.id), ids);
  assert.ok(layers.every((layer) => layer.parentId === null));
});

test("layer.ungroup rejects a non-group layer", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  await handleExecute(bridge, { operations: [{ name: "layer.addBlank", arguments: {} }] });
  const result = await execute(bridge, { operations: [{ name: "layer.ungroup", arguments: { layerId: "active" } }] });
  assert.equal(result.ok, false);
  assert.equal(result.results[0]?.error?.code, "invalid_arguments");
});

test("layer.featherMask feathers a mask and errors without one", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  await handleExecute(bridge, { operations: [{ name: "layer.addBlank", arguments: {} }] });
  const missing = await execute(bridge, {
    operations: [{ name: "layer.featherMask", arguments: { layerId: "active", radius: 12 } }],
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.results[0]?.error?.code, "not_found");
  const feathered = await execute(bridge, {
    operations: [
      { name: "layer.addMask", arguments: { layerId: "active" } },
      { name: "layer.featherMask", arguments: { layerId: "active", radius: 12 } },
    ],
  });
  assert.equal(feathered.ok, true);
});

test("layer.distort commits valid corners and rejects bad input", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  await handleExecute(bridge, { operations: [{ name: "layer.addBlank", arguments: {} }] });
  const result = await execute(bridge, {
    operations: [
      {
        name: "layer.distort",
        arguments: {
          layerId: "active",
          corners: [
            { x: 0, y: 0 },
            { x: 640, y: 40 },
            { x: 640, y: 440 },
            { x: 0, y: 480 },
          ],
        },
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.throws(
    () =>
      validateExecuteRequest({
        operations: [
          { name: "layer.distort", arguments: { layerId: "active", corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] } },
        ],
      }),
    /at least 4/i,
  );
  const twisted = await execute(bridge, {
    operations: [
      {
        name: "layer.distort",
        arguments: {
          layerId: "active",
          corners: [
            { x: 0, y: 0 },
            { x: 640, y: 440 },
            { x: 640, y: 0 },
            { x: 0, y: 440 },
          ],
        },
      },
    ],
  });
  assert.equal(twisted.ok, false);
  assert.equal(twisted.results[0]?.error?.code, "invalid_arguments");
});

test("atomic crop + failing transform rolls back cleanly", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  await execute(bridge, { operations: [{ name: "document.crop", arguments: { x: 64, y: 64, width: 512, height: 512 } }] });
  const result = await execute(bridge, {
    atomic: true,
    operations: [
      { name: "document.crop", arguments: { x: 0, y: 0, width: 256, height: 256 } },
      { name: "layer.transform", arguments: { layerId: "does-not-exist", x: 0 } },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.state.current?.width, 512);
});

test("dry-run validates the new geometry operations", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  const result = await execute(bridge, {
    dryRun: true,
    operations: [
      { name: "document.crop", arguments: { x: 0, y: 0, width: 100, height: 100 } },
      { name: "document.resizeCanvas", arguments: { width: 2000, height: 1000 } },
      { name: "document.resizeImage", arguments: { width: 600, height: 400 } },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.results.every((entry) => entry.ok), true);
  assert.equal(result.state.current?.width, 1200);
});
