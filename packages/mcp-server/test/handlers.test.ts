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
    () => validateExecuteRequest({ operations: [{ name: "pixels.contentAwareFill", arguments: {} }], dryRun: true }),
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

interface MockBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MockState {
  current: {
    width: number;
    height: number;
    resolution: number;
    layers: Array<{ id: string; parentId: string | null; group: boolean; mask: boolean; fill: MockBounds | null; transform: { x: number; y: number; width: number; height: number } }>;
    selectedLayerIds: string[];
    selection: MockBounds | null;
  } | null;
}

interface SelectionSnapshot {
  exists: boolean;
  antialiased: boolean;
  bounds: MockBounds;
}

const execute = async (bridge: MockBridgeTransport, request: ExecuteRequest) =>
  (await handleExecute(bridge, request)) as {
    ok: boolean;
    rolledBack?: boolean;
    results: Array<{ ok: boolean; value?: unknown; error?: { code: string } }>;
    state: MockState;
  };

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

test("selection.rectangle replace reports bounds equal to the rect", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  const result = await execute(bridge, {
    operations: [{ name: "selection.rectangle", arguments: { x: 40, y: 40, width: 400, height: 300, mode: "replace" } }],
  });
  assert.equal(result.ok, true);
  const snapshot = result.results[0]?.value as SelectionSnapshot;
  assert.equal(snapshot.exists, true);
  assert.deepEqual(snapshot.bounds, { x: 40, y: 40, width: 400, height: 300 });
  assert.deepEqual(result.state.current?.selection, { x: 40, y: 40, width: 400, height: 300 });

  const got = await execute(bridge, { operations: [{ name: "selection.get" }] });
  const reported = got.results[0]?.value as SelectionSnapshot;
  assert.deepEqual(reported.bounds, { x: 40, y: 40, width: 400, height: 300 });
});

test("selection.ellipse add grows the combined selection bounds", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  await execute(bridge, {
    operations: [{ name: "selection.rectangle", arguments: { x: 40, y: 40, width: 400, height: 300 } }],
  });
  const result = await execute(bridge, {
    operations: [{ name: "selection.ellipse", arguments: { x: 500, y: 100, width: 200, height: 200, mode: "add" } }],
  });
  assert.equal(result.ok, true);
  const snapshot = result.results[0]?.value as SelectionSnapshot;
  assert.ok(snapshot.bounds.width > 400, "combined coverage must grow beyond the first rect");
  assert.equal(snapshot.bounds.x, 40);
  assert.equal(snapshot.bounds.y, 40);
});

test("selection.polygon selects a five-point outline and rejects two points", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  const result = await execute(bridge, {
    operations: [
      {
        name: "selection.polygon",
        arguments: {
          points: [
            { x: 120, y: 80 },
            { x: 260, y: 60 },
            { x: 300, y: 220 },
            { x: 200, y: 280 },
            { x: 150, y: 260 },
          ],
        },
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal((result.results[0]?.value as SelectionSnapshot).exists, true);
  assert.throws(
    () =>
      validateExecuteRequest({
        operations: [{ name: "selection.polygon", arguments: { points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] } }],
      }),
    /at least 3/i,
  );
});

test("selection.magicWand selects a flat-colour region and wider tolerance expands it", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  await execute(bridge, { operations: [{ name: "layer.addBlank", arguments: {} }] });
  const narrow = await execute(bridge, {
    operations: [{ name: "selection.magicWand", arguments: { x: 600, y: 400, tolerance: 8 } }],
  });
  assert.equal(narrow.ok, true);
  const narrowBounds = (narrow.results[0]?.value as SelectionSnapshot).bounds;
  const wide = await execute(bridge, {
    operations: [{ name: "selection.magicWand", arguments: { x: 600, y: 400, tolerance: 96 } }],
  });
  assert.equal(wide.ok, true);
  const wideBounds = (wide.results[0]?.value as SelectionSnapshot).bounds;
  assert.ok(wideBounds.width > narrowBounds.width && wideBounds.height > narrowBounds.height);
});

test("selection.magicWand with nothing to sample leaves an empty selection", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  await execute(bridge, {
    operations: [{ name: "selection.rectangle", arguments: { x: 10, y: 10, width: 50, height: 50 } }],
  });
  const result = await execute(bridge, {
    operations: [{ name: "selection.magicWand", arguments: { x: 600, y: 400 } }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.results[0]?.value, null);
  assert.equal(result.state.current?.selection, null);
});

test("selection add mode with no existing selection behaves as replace", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  const result = await execute(bridge, {
    operations: [{ name: "selection.rectangle", arguments: { x: 20, y: 20, width: 100, height: 80, mode: "add" } }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual((result.results[0]?.value as SelectionSnapshot).bounds, { x: 20, y: 20, width: 100, height: 80 });
});

test("atomic rectangle select + pixels.fill fills the region and rolls back on failure", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  await execute(bridge, { operations: [{ name: "layer.addBlank", arguments: { name: "Fill" } }] });
  const filled = await execute(bridge, {
    atomic: true,
    operations: [
      { name: "selection.rectangle", arguments: { x: 10, y: 10, width: 100, height: 100 } },
      { name: "pixels.fill", arguments: { target: "foreground" } },
    ],
  });
  assert.equal(filled.ok, true);
  assert.equal(filled.rolledBack, false);
  assert.deepEqual(filled.state.current?.layers[0]?.fill, { x: 10, y: 10, width: 100, height: 100 });

  const rolled = await execute(bridge, {
    atomic: true,
    operations: [
      { name: "selection.rectangle", arguments: { x: 300, y: 300, width: 200, height: 200 } },
      { name: "layer.transform", arguments: { layerId: "does-not-exist", x: 0 } },
    ],
  });
  assert.equal(rolled.ok, false);
  assert.equal(rolled.rolledBack, true);
  assert.deepEqual(rolled.state.current?.selection, { x: 10, y: 10, width: 100, height: 100 });
});

interface PaintOutcome {
  applied: boolean;
  layerId?: string;
  mask?: boolean;
  points?: number;
  bounds?: MockBounds | null;
}

const addPaintableLayer = async (bridge: MockBridgeTransport, name = "Art") => {
  const result = await handleExecute(bridge, { operations: [{ name: "layer.addBlank", arguments: { name } }] });
  const state = (result as { state: MockState }).state;
  return state.current?.layers[state.current.layers.length - 1]?.id;
};

test("paint.brushStroke covers the path's bounds, single undo-style commit", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  await addPaintableLayer(bridge);
  const result = await execute(bridge, {
    operations: [
      {
        name: "paint.brushStroke",
        arguments: {
          points: [
            { x: 40, y: 40 },
            { x: 120, y: 90 },
            { x: 200, y: 60 },
          ],
          diameter: 20,
        },
      },
    ],
  });
  assert.equal(result.ok, true);
  const outcome = result.results[0]?.value as PaintOutcome;
  assert.equal(outcome.applied, true);
  assert.equal(outcome.points, 3);
  // 20 px brush: coverage is the point bounds grown by the 10 px radius.
  assert.deepEqual(outcome.bounds, { x: 30, y: 30, width: 180, height: 70 });
});

test("paint.brushStroke paints a single-point dot and accepts erase mode", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  await addPaintableLayer(bridge);
  const dot = await execute(bridge, {
    operations: [{ name: "paint.brushStroke", arguments: { points: [{ x: 100, y: 100 }], diameter: 10 } }],
  });
  assert.equal(dot.ok, true);
  assert.equal((dot.results[0]?.value as PaintOutcome).applied, true);
  const erased = await execute(bridge, {
    operations: [{ name: "paint.brushStroke", arguments: { mode: "erase", points: [{ x: 100, y: 100 }, { x: 120, y: 100 }] } }],
  });
  assert.equal(erased.ok, true);
  assert.equal((erased.results[0]?.value as PaintOutcome).applied, true);
});

test("paint.brushStroke fully off-canvas is a no-op, not an error", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  await addPaintableLayer(bridge);
  const result = await execute(bridge, {
    operations: [{ name: "paint.brushStroke", arguments: { points: [{ x: -500, y: -500 }, { x: -400, y: -400 }] } }],
  });
  assert.equal(result.ok, true);
  const outcome = result.results[0]?.value as PaintOutcome;
  assert.equal(outcome.applied, false);
  assert.equal(outcome.bounds, null);
});

test("paint.brushStroke on a group layer fails with pixel_edit_unavailable", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  const first = await addPaintableLayer(bridge, "A");
  const second = await addPaintableLayer(bridge, "B");
  const grouped = await execute(bridge, {
    operations: [
      { name: "layer.select", arguments: { layerIds: [first, second] } },
      { name: "layer.group", arguments: {} },
    ],
  });
  assert.equal(grouped.ok, true);
  const result = await execute(bridge, {
    operations: [{ name: "paint.brushStroke", arguments: { points: [{ x: 10, y: 10 }] } }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.results[0]?.error?.code, "pixel_edit_unavailable");
});

test("paint.spotHeal accepts every upstream healing mode", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  await addPaintableLayer(bridge);
  for (const mode of ["Content-Aware", "Create Texture", "Proximity Match"]) {
    const result = await execute(bridge, {
      operations: [{ name: "paint.spotHeal", arguments: { points: [{ x: 100, y: 100 }, { x: 140, y: 140 }], mode } }],
    });
    assert.equal(result.ok, true, mode);
    assert.equal((result.results[0]?.value as PaintOutcome).applied, true, mode);
  }
  assert.throws(
    () =>
      validateExecuteRequest({
        operations: [{ name: "paint.spotHeal", arguments: { points: [{ x: 1, y: 1 }], mode: "Imaginary" } }],
      }),
    /invalid_arguments|must be one of/i,
  );
});

test("paint.clone requires a source and samples it along the path", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  await addPaintableLayer(bridge);
  assert.throws(
    () =>
      validateExecuteRequest({
        operations: [{ name: "paint.clone", arguments: { points: [{ x: 10, y: 10 }] } }],
      }),
    /source.*required/i,
  );
  const result = await execute(bridge, {
    operations: [
      {
        name: "paint.clone",
        arguments: { source: { x: 100, y: 100 }, points: [{ x: 400, y: 300 }, { x: 460, y: 320 }], aligned: true, sampleAllLayers: false },
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal((result.results[0]?.value as PaintOutcome).applied, true);
});

test("paint.blur accepts Blur, Smudge and Liquify modes", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  await addPaintableLayer(bridge);
  for (const mode of ["Blur", "Smudge", "Liquify"]) {
    const result = await execute(bridge, {
      operations: [{ name: "paint.blur", arguments: { mode, points: [{ x: 50, y: 50 }, { x: 200, y: 200 }], strength: 0.5 } }],
    });
    assert.equal(result.ok, true, mode);
    assert.equal((result.results[0]?.value as PaintOutcome).applied, true, mode);
  }
});

test("paint.gradient commits a ramp and paint.shape creates a shape layer", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  await addPaintableLayer(bridge);
  const gradient = await execute(bridge, {
    operations: [{ name: "paint.gradient", arguments: { start: { x: 100, y: 100 }, end: { x: 700, y: 500 }, shape: "Linear" } }],
  });
  assert.equal(gradient.ok, true);
  const gradientOutcome = gradient.results[0]?.value as PaintOutcome;
  assert.equal(gradientOutcome.applied, true);
  assert.deepEqual(gradientOutcome.bounds, { x: 0, y: 0, width: 1200, height: 800 });

  const withStops = await execute(bridge, {
    operations: [
      {
        name: "paint.gradient",
        arguments: {
          start: { x: 400, y: 300 },
          end: { x: 600, y: 300 },
          shape: "Radial",
          stops: [
            { offset: 0, color: "#FF8800" },
            { offset: 0.5, color: "#00FF00" },
            { offset: 1, color: "#0033FF" },
          ],
        },
      },
    ],
  });
  assert.equal(withStops.ok, true);

  const shape = await execute(bridge, {
    operations: [{ name: "paint.shape", arguments: { kind: "Rectangle", x: 50, y: 50, width: 200, height: 120, cornerRadius: 16, color: "#3366FF" } }],
  });
  assert.equal(shape.ok, true);
  const layer = shape.results[0]?.value as { id: string; shape: boolean; transform: { x: number; y: number; width: number; height: number } };
  assert.equal(layer.shape, true);
  assert.deepEqual(layer.transform, { x: 50, y: 50, width: 200, height: 120, rotation: 0, flipX: false, flipY: false, sampling: "High quality" });
  assert.equal(shape.state.current?.layers.at(-1)?.id, layer.id);
});

test("paint strokes clip to the active selection", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  await addPaintableLayer(bridge);
  const result = await execute(bridge, {
    atomic: true,
    operations: [
      { name: "selection.rectangle", arguments: { x: 100, y: 100, width: 200, height: 200 } },
      { name: "paint.brushStroke", arguments: { points: [{ x: 50, y: 150 }, { x: 500, y: 150 }], diameter: 20 } },
    ],
  });
  assert.equal(result.ok, true);
  const outcome = result.results[1]?.value as PaintOutcome;
  // The unclipped band would run to x=510; the selection cuts it off at x=300.
  assert.deepEqual(outcome.bounds, { x: 100, y: 140, width: 200, height: 20 });
});

test("an atomic batch of two strokes rolls back as one", async () => {
  const bridge = new MockBridgeTransport();
  await createDocument(bridge);
  const layerId = await addPaintableLayer(bridge);
  const result = await execute(bridge, {
    atomic: true,
    operations: [
      { name: "paint.brushStroke", arguments: { points: [{ x: 10, y: 10 }, { x: 100, y: 10 }] } },
      { name: "paint.brushStroke", arguments: { points: [{ x: 10, y: 50 }, { x: 100, y: 50 }] } },
      { name: "layer.transform", arguments: { layerId: "does-not-exist", x: 0 } },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  const layer = result.state.current?.layers.find((candidate) => candidate.id === layerId);
  assert.equal(layer?.fill, null);
});

test("paint operations require a document", async () => {
  const bridge = new MockBridgeTransport();
  for (const [name, args] of [
    ["paint.brushStroke", { points: [{ x: 1, y: 1 }] }],
    ["paint.spotHeal", { points: [{ x: 1, y: 1 }] }],
    ["paint.clone", { source: { x: 0, y: 0 }, points: [{ x: 1, y: 1 }] }],
    ["paint.blur", { points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }],
    ["paint.gradient", { start: { x: 0, y: 0 }, end: { x: 10, y: 10 } }],
    ["paint.shape", { x: 0, y: 0, width: 10, height: 10 }],
  ] as const) {
    const result = await execute(bridge, { operations: [{ name, arguments: args }] });
    assert.equal(result.ok, false, name);
    assert.equal(result.results[0]?.error?.code, "document_required", name);
  }
});

test("paint stroke points are schema-bounded and validated", () => {
  assert.throws(
    () =>
      validateExecuteRequest({
        operations: [{ name: "paint.brushStroke", arguments: { points: [] } }],
      }),
    /at least 1/i,
  );
  const tooMany = Array.from({ length: 100_001 }, (_, index) => ({ x: index % 1000, y: index % 500 }));
  assert.throws(
    () =>
      validateExecuteRequest({
        operations: [{ name: "paint.brushStroke", arguments: { points: tooMany } }],
      }),
    /at most 100000/i,
  );
});

test("selection tools require an open document", async () => {
  const bridge = new MockBridgeTransport();
  for (const [name, args] of [
    ["selection.rectangle", { x: 0, y: 0, width: 10, height: 10 }],
    ["selection.ellipse", { x: 0, y: 0, width: 10, height: 10 }],
    ["selection.polygon", { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }],
    ["selection.magicWand", { x: 5, y: 5 }],
  ] as const) {
    const result = await execute(bridge, { operations: [{ name, arguments: args }] });
    assert.equal(result.ok, false, name);
    assert.equal(result.results[0]?.error?.code, "document_required", name);
  }
});
