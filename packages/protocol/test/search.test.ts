import assert from "node:assert/strict";
import test from "node:test";
import { CAPABILITIES, CAPABILITY_BY_NAME, searchCapabilities } from "../src/index.js";

test("capability names are unique", () => {
  assert.equal(CAPABILITIES.length, CAPABILITY_BY_NAME.size);
});

test("search ranks an exact operation first", () => {
  const [first] = searchCapabilities("layer.setOpacity");
  assert.equal(first?.capability.name, "layer.setOpacity");
});

test("search understands natural language aliases", () => {
  const [first] = searchCapabilities("save png");
  assert.equal(first?.capability.name, "document.export");
});

test("planned capabilities are hidden by default", () => {
  const defaultResults = searchCapabilities("brush stroke", { limit: 50 });
  assert.equal(defaultResults.some((hit) => hit.capability.name === "paint.brushStroke"), false);

  const allResults = searchCapabilities("brush stroke", { limit: 50, includePlanned: true });
  assert.equal(allResults.some((hit) => hit.capability.name === "paint.brushStroke"), true);
});

test("all catalogue examples satisfy their advertised schemas", async () => {
  const { validateJsonSchema } = await import("../src/index.js");
  for (const capability of CAPABILITIES) {
    for (const example of capability.examples) {
      assert.deepEqual(
        validateJsonSchema(capability.inputSchema, example.arguments),
        [],
        `${capability.name} has an invalid example`,
      );
    }
  }
});

test("every planned capability carries a full contract", () => {
  const planned = CAPABILITIES.filter((entry) => entry.status === "planned");
  assert.equal(planned.length, 10);
  for (const capability of planned) {
    assert.ok(capability.inputSchema.type === "object" || capability.inputSchema.oneOf, `${capability.name} has no object schema`);
    assert.ok(capability.examples.length > 0, `${capability.name} has no examples`);
    assert.ok(capability.aliases.length > 0 || capability.tags.length > 0, `${capability.name} has no aliases or tags`);
  }
});

test("adjustment.add resolves the correct oneOf branch for every kind", async () => {
  const { validateJsonSchema } = await import("../src/index.js");
  const schema = CAPABILITY_BY_NAME.get("adjustment.add")!.inputSchema;
  const cases = [
    { kind: "Hue/Saturation", parameters: { range: "Reds", saturation: -30, colorize: false } },
    { kind: "Levels", parameters: { channel: "RGB", ranges: [{ gamma: 1.2 }, { black: 10 }, { white: 240 }, {}] } },
    {
      kind: "Curves",
      parameters: {
        channels: [
          [
            { x: 0, y: 0 },
            { x: 255, y: 200 },
          ],
          [
            { x: 0, y: 0 },
            { x: 255, y: 255 },
          ],
          [
            { x: 0, y: 0 },
            { x: 255, y: 255 },
          ],
          [
            { x: 0, y: 0 },
            { x: 255, y: 255 },
          ],
        ],
      },
    },
    { kind: "Exposure", parameters: { exposure: 0.5, offset: -0.02, gamma: 1.1 } },
    {
      kind: "Gradient Map",
      parameters: {
        shadows: { red: 0, green: 0, blue: 0.2 },
        highlights: { red: 1, green: 0.9, blue: 0.6 },
        reversed: true,
      },
    },
    { kind: "Grain", parameters: { amount: 40, size: 2, roughness: 70, seed: 7 } },
  ];
  for (const args of cases) {
    assert.deepEqual(validateJsonSchema(schema, args), [], `${args.kind} should validate`);
  }
});

test("adjustment.add rejects parameters from another kind with a named path", async () => {
  const { validateJsonSchema } = await import("../src/index.js");
  const schema = CAPABILITY_BY_NAME.get("adjustment.add")!.inputSchema;

  const issues = validateJsonSchema(schema, { kind: "Exposure", parameters: { radius: 8 } });
  assert.ok(issues.length > 0, "cross-kind parameters must fail");
  assert.equal(issues[0]!.path, "$");
  assert.match(issues[0]!.message, /exactly one/);

  assert.ok(validateJsonSchema(schema, { kind: "Imaginary" }).length > 0, "unknown kind must fail");
  assert.ok(
    validateJsonSchema(schema, { parameters: { exposure: 1 } }).length > 0,
    "missing kind must fail",
  );
});

test("adjustment.update requires a layer id and kind-matched parameters", async () => {
  const { validateJsonSchema } = await import("../src/index.js");
  const schema = CAPABILITY_BY_NAME.get("adjustment.update")!.inputSchema;

  assert.deepEqual(
    validateJsonSchema(schema, { layerId: "active", kind: "Grain", parameters: { amount: 60 } }),
    [],
  );
  assert.ok(
    validateJsonSchema(schema, { layerId: "active", kind: "Grain" }).length > 0,
    "missing parameters must fail",
  );
  assert.ok(
    validateJsonSchema(schema, { kind: "Grain", parameters: { amount: 60 } }).length > 0,
    "missing layerId must fail",
  );
  assert.ok(
    validateJsonSchema(schema, { layerId: "active", kind: "Grain", parameters: { distortion: 10 } }).length > 0,
    "cross-kind parameters must fail",
  );
});

test("filter.apply validates settings per filter kind", async () => {
  const { validateJsonSchema } = await import("../src/index.js");
  const schema = CAPABILITY_BY_NAME.get("filter.apply")!.inputSchema;

  assert.deepEqual(
    validateJsonSchema(schema, {
      kind: "Remove Background",
      settings: { backgroundQuality: "Advanced", refineEdges: 20, matteContrast: 30, shiftEdge: -2 },
    }),
    [],
  );
  assert.deepEqual(validateJsonSchema(schema, { kind: "Gaussian Blur", settings: { radius: 12 } }), []);
  assert.deepEqual(validateJsonSchema(schema, { kind: "Content-Aware Fill" }), []);
  assert.deepEqual(
    validateJsonSchema(schema, { kind: "Motion Blur", settings: { angle: 45, distance: 80 } }),
    [],
  );

  const crossKind = validateJsonSchema(schema, {
    kind: "Gaussian Blur",
    settings: { backgroundQuality: "Advanced" },
  });
  assert.ok(crossKind.length > 0, "cross-kind settings must fail");
  assert.equal(crossKind[0]!.path, "$");

  assert.ok(
    validateJsonSchema(schema, { kind: "Remove Background", settings: { radius: 12 } }).length > 0,
    "blur radius on removeBackground must fail",
  );
  assert.ok(
    validateJsonSchema(schema, { kind: "Content-Aware Fill", settings: { radius: 4 } }).length > 0,
    "settings on the automatic fill must fail",
  );
});
