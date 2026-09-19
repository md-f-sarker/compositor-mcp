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
