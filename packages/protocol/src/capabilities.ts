import type { Capability, JsonObject, JsonSchema } from "./types.js";

const object = (
  properties: Record<string, JsonSchema> = {},
  required: string[] = [],
  additionalProperties = false,
): JsonSchema => ({ type: "object", properties, required, additionalProperties });

const string = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({
  type: "string",
  description,
  ...extra,
});

const number = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({
  type: "number",
  description,
  ...extra,
});

const integer = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({
  type: "integer",
  description,
  ...extra,
});

const boolean = (description: string, defaultValue?: boolean): JsonSchema => ({
  type: "boolean",
  description,
  ...(defaultValue === undefined ? {} : { default: defaultValue }),
});

interface CapabilityInit {
  name: string;
  title: string;
  description: string;
  category: string;
  risk?: Capability["risk"];
  status?: Capability["status"];
  transactional?: boolean;
  aliases?: string[];
  tags?: string[];
  inputSchema?: JsonSchema;
  examples?: Array<{ arguments: JsonObject; note?: string }>;
}

const capability = (value: CapabilityInit): Capability => ({
  risk: "write",
  status: "implemented",
  transactional: true,
  aliases: [],
  tags: [],
  inputSchema: object(),
  examples: [],
  ...value,
});

const layerId = string("Layer UUID, or the special value 'active'.", {
  examples: ["active", "1F8B2E85-8E45-4F3E-AEC9-92E42B69CC9C"],
});

const projectId = string("Project tab UUID, or the special value 'current'.", {
  examples: ["current"],
});

const path = string("Absolute macOS file path inside an MCP-authorised root.", {
  minLength: 1,
  examples: ["/Users/me/Pictures/output.png"],
});

const point = object(
  { x: number("X coordinate in document pixels."), y: number("Y coordinate in document pixels.") },
  ["x", "y"],
);

/// How a selection operation combines with the existing selection — the `mode`
/// field shared by every selection-mutating operation.
const selectionMode = string("Selection combination mode.", { enum: ["replace", "add", "subtract"], default: "replace" });

/// The marquee rectangle {x, y, width, height, mode} shared by
/// selection.rectangle and selection.ellipse.
const marqueeRect = object(
  {
    x: number("Left coordinate."), y: number("Top coordinate."),
    width: number("Width.", { minimum: 1 }), height: number("Height.", { minimum: 1 }),
    mode: selectionMode,
  },
  ["x", "y", "width", "height"],
);

const strokePoints = (description: string): JsonSchema => ({
  type: "array",
  description,
  items: point,
  minItems: 1,
  maxItems: 100000,
});

const brushDiameter = number("Brush diameter in document pixels, 1–2000.", {
  minimum: 1,
  maximum: 2000,
  default: 40,
});
const brushHardness = number("Brush hardness from 0 to 1.", { minimum: 0, maximum: 1, default: 1 });
const brushOpacity = number("Brush opacity from 0.01 to 1.", { minimum: 0.01, maximum: 1, default: 1 });

const hexColor = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema =>
  string(description, { pattern: "^#[0-9A-Fa-f]{6}$", ...extra });

const adjustmentColor = object(
  {
    red: number("Red channel from 0 to 1.", { minimum: 0, maximum: 1 }),
    green: number("Green channel from 0 to 1.", { minimum: 0, maximum: 1 }),
    blue: number("Blue channel from 0 to 1.", { minimum: 0, maximum: 1 }),
  },
  ["red", "green", "blue"],
);

const COLOUR_RANGES = ["Master", "Reds", "Yellows", "Greens", "Cyans", "Blues", "Magentas"] as const;
const LEVELS_CHANNELS = ["RGB", "Red", "Green", "Blue"] as const;

const perColourRange = (value: JsonSchema): JsonSchema =>
  object(Object.fromEntries(COLOUR_RANGES.map((range) => [range, value])));

const rangeAdjustment = object({
  hue: number("Hue shift, −360 to 360.", { minimum: -360, maximum: 360 }),
  saturation: number("Saturation shift, −100 to 100.", { minimum: -100, maximum: 100 }),
  lightness: number("Lightness shift, −100 to 100.", { minimum: -100, maximum: 100 }),
});

const hueBand = object(
  {
    falloffStart: number("Falloff start in degrees, 0–360.", { minimum: 0, maximum: 360 }),
    rangeStart: number("Full-strength range start in degrees, 0–360.", { minimum: 0, maximum: 360 }),
    rangeEnd: number("Full-strength range end in degrees, 0–360.", { minimum: 0, maximum: 360 }),
    falloffEnd: number("Falloff end in degrees, 0–360.", { minimum: 0, maximum: 360 }),
  },
  ["falloffStart", "rangeStart", "rangeEnd", "falloffEnd"],
);

const hsvParameters = object({
  range: string("Colour range the direct sliders edit.", { enum: [...COLOUR_RANGES], default: "Master" }),
  colorize: boolean("Colourise instead of shifting existing colour.", false),
  invertRange: boolean("Apply the selected range to everything outside its band.", false),
  hue: number("Hue shift for the selected range, −360 to 360.", { minimum: -360, maximum: 360 }),
  saturation: number("Saturation shift for the selected range, −100 to 100.", { minimum: -100, maximum: 100 }),
  lightness: number("Lightness shift for the selected range, −100 to 100.", { minimum: -100, maximum: 100 }),
  adjustments: {
    ...perColourRange(rangeAdjustment),
    description: "Per-range hue, saturation and lightness shifts keyed by range name.",
  },
  bands: { ...perColourRange(hueBand), description: "Per-range hue bands keyed by range name." },
});

const levelRange = object({
  black: number("Input black point, 0–254.", { minimum: 0, maximum: 254, default: 0 }),
  gamma: number("Midtone gamma, 0.1–9.99.", { minimum: 0.1, maximum: 9.99, default: 1 }),
  white: number("Input white point, 1–255.", { minimum: 1, maximum: 255, default: 255 }),
  outputBlack: number("Output black point, 0–255.", { minimum: 0, maximum: 255, default: 0 }),
  outputWhite: number("Output white point, 0–255.", { minimum: 0, maximum: 255, default: 255 }),
});

const levelsParameters = object({
  channel: string("Channel shown in the Levels panel.", { enum: [...LEVELS_CHANNELS], default: "RGB" }),
  ranges: {
    type: "array",
    description: "Input/output ranges ordered RGB, Red, Green, Blue.",
    items: levelRange,
    minItems: 4,
    maxItems: 4,
  },
});

const curvePoint = object(
  {
    x: number("Input value, 0–255.", { minimum: 0, maximum: 255 }),
    y: number("Output value, 0–255.", { minimum: 0, maximum: 255 }),
  },
  ["x", "y"],
);

const curvesParameters = object({
  channel: string("Channel shown in the Curves panel.", { enum: [...LEVELS_CHANNELS], default: "RGB" }),
  channels: {
    type: "array",
    description: "Point lists ordered RGB, Red, Green, Blue; each runs from x 0 to x 255 with strictly increasing x.",
    items: { type: "array", items: curvePoint, minItems: 2, maxItems: 32 },
    minItems: 4,
    maxItems: 4,
  },
});

const exposureParameters = object({
  exposure: number("Stops of light, −20 to 20.", { minimum: -20, maximum: 20, default: 0 }),
  offset: number("Linear-light offset, −0.5 to 0.5.", { minimum: -0.5, maximum: 0.5, default: 0 }),
  gamma: number("Gamma correction, 0.01–9.99.", { minimum: 0.01, maximum: 9.99, default: 1 }),
});

const gradientMapParameters = object({
  shadows: { ...adjustmentColor, description: "Colour mapped to the darkest tones." },
  highlights: { ...adjustmentColor, description: "Colour mapped to the lightest tones." },
  reversed: boolean("Swap the shadow and highlight colours.", false),
});

const grainParameters = object({
  amount: number("Grain strength, 0–100.", { minimum: 0, maximum: 100 }),
  size: number("Grain scale in document pixels, 0.5–20.", { minimum: 0.5, maximum: 20 }),
  roughness: number("Per-pixel noise roughness, 0–100.", { minimum: 0, maximum: 100 }),
  seed: integer("Noise pattern seed.", { minimum: 0, maximum: 4294967295 }),
});

// filter.apply Grain runs with the filter edit's own random seed — only the
// adjustment layer honours a caller-supplied one, so the filter schema omits it.
const grainFilterParameters = object({
  amount: number("Grain strength, 0–100.", { minimum: 0, maximum: 100 }),
  size: number("Grain scale in document pixels, 0.5–20.", { minimum: 0.5, maximum: 20 }),
  roughness: number("Per-pixel noise roughness, 0–100.", { minimum: 0, maximum: 100 }),
});

const kindConst = (kind: string, description: string): JsonSchema => ({
  type: "string",
  description,
  const: kind,
});

const ADJUSTMENT_PARAMETERS: ReadonlyArray<readonly [string, JsonSchema]> = [
  ["Hue/Saturation", hsvParameters],
  ["Levels", levelsParameters],
  ["Curves", curvesParameters],
  ["Exposure", exposureParameters],
  ["Gradient Map", gradientMapParameters],
  ["Grain", grainParameters],
];

const FILTER_SETTINGS: ReadonlyArray<readonly [string, JsonSchema]> = [
  [
    "Gaussian Blur",
    object({
      radius: number("Blur radius in layer pixels, 0.1–250.", { minimum: 0.1, maximum: 250 }),
    }),
  ],
  [
    "Motion Blur",
    object({
      angle: number("Streak direction in degrees, −90 to 90.", { minimum: -90, maximum: 90, default: 0 }),
      distance: number("Streak length in layer pixels, 1–2000.", { minimum: 1, maximum: 2000 }),
    }),
  ],
  [
    "Add Noise",
    {
      ...object({
        amount: number("Noise strength as a percentage, 0.1–400.", { minimum: 0.1, maximum: 400 }),
        gaussian: boolean("Gaussian distribution instead of uniform.", false),
        monochromatic: boolean("Brightness-only noise.", false),
      }),
      description:
        "Add Noise settings. The bridge cannot honour a noise seed here — use the Grain kind's seed when a reproducible pattern matters.",
    },
  ],
  [
    "Lens Correction",
    object({
      distortion: number("Remove Distortion amount, −100 to 100; positive straightens barrel distortion.", {
        minimum: -100,
        maximum: 100,
      }),
    }),
  ],
  [
    "Remove Background",
    object({
      backgroundQuality: string("Subject mask quality; Advanced refines the mask against the layer's detail.", {
        enum: ["Basic", "Advanced"],
        default: "Basic",
      }),
      refineEdges: number("Edge refinement reach in layer pixels, 0–40.", { minimum: 0, maximum: 40 }),
      matteContrast: number("Matte contrast, 0–100.", { minimum: 0, maximum: 100 }),
      shiftEdge: number("Mask edge shift in layer pixels, −10 to 10.", { minimum: -10, maximum: 10 }),
    }),
  ],
  ["Content-Aware Fill", object()],
  ["Curves", curvesParameters],
  ["Exposure", exposureParameters],
  ["Gradient Map", gradientMapParameters],
  ["Grain", grainFilterParameters],
];

export const CAPABILITIES: readonly Capability[] = [
  capability({
    name: "app.ping",
    title: "Ping Compositor",
    description: "Check that the Compositor app bridge is running and authenticated.",
    category: "app",
    risk: "read",
    transactional: false,
    aliases: ["health", "status", "connect"],
    tags: ["diagnostics", "bridge"],
  }),
  capability({
    name: "app.getState",
    title: "Get editor state",
    description: "Return open projects, current document metadata, active layer, selection and revision.",
    category: "app",
    risk: "read",
    transactional: false,
    aliases: ["inspect", "snapshot", "current state"],
    tags: ["state", "projects", "layers"],
    inputSchema: object({ includeLayers: boolean("Include the current document's layer list.", true) }),
    examples: [{ arguments: { includeLayers: true } }],
  }),
  capability({
    name: "workspace.list",
    title: "List projects",
    description: "List all open Compositor project tabs and identify the selected tab.",
    category: "workspace",
    risk: "read",
    transactional: false,
    aliases: ["list tabs", "open projects"],
    tags: ["tabs", "projects"],
  }),
  capability({
    name: "workspace.select",
    title: "Select project",
    description: "Make an open project tab current.",
    category: "workspace",
    transactional: false,
    inputSchema: object({ projectId }, ["projectId"]),
    examples: [{ arguments: { projectId: "current" } }],
  }),
  capability({
    name: "document.create",
    title: "Create document",
    description: "Create a new canvas in a new or reusable project tab.",
    category: "document",
    transactional: false,
    inputSchema: object(
      {
        width: integer("Canvas width in pixels.", { minimum: 1, maximum: 30000 }),
        height: integer("Canvas height in pixels.", { minimum: 1, maximum: 30000 }),
        resolution: number("Resolution in DPI.", { minimum: 1, maximum: 2400, default: 72 }),
      },
      ["width", "height"],
    ),
    examples: [{ arguments: { width: 1920, height: 1080, resolution: 72 } }],
  }),
  capability({
    name: "document.open",
    title: "Open Compositor project",
    description: "Open a .comp project from an authorised local path.",
    category: "document",
    risk: "filesystem",
    transactional: false,
    aliases: ["load project"],
    tags: ["file", "comp"],
    inputSchema: object({ path }, ["path"]),
    examples: [{ arguments: { path: "/Users/me/Pictures/design.comp" } }],
  }),
  capability({
    name: "document.save",
    title: "Save project",
    description: "Save the current project to its existing path or an authorised .comp path.",
    category: "document",
    risk: "filesystem",
    transactional: false,
    aliases: ["save as", "write project"],
    tags: ["file", "comp"],
    inputSchema: object({ path: { ...path, description: "Optional destination. Required for an untitled project." } }),
    examples: [{ arguments: {} }, { arguments: { path: "/Users/me/Pictures/design.comp" } }],
  }),
  capability({
    name: "document.importImages",
    title: "Import images",
    description: "Import one or more JPEG, PNG, HEIC or TIFF files as layers.",
    category: "document",
    risk: "filesystem",
    transactional: false,
    aliases: ["add image", "place images"],
    tags: ["import", "layers", "file"],
    inputSchema: object(
      {
        paths: { type: "array", items: path, minItems: 1, maxItems: 100 },
        x: number("Optional document-space insertion x coordinate."),
        y: number("Optional document-space insertion y coordinate."),
      },
      ["paths"],
    ),
    examples: [{ arguments: { paths: ["/Users/me/Pictures/product.png"] } }],
  }),
  capability({
    name: "document.export",
    title: "Export flattened image",
    description: "Render the current document and write PNG or JPEG to an authorised path.",
    category: "document",
    risk: "filesystem",
    transactional: false,
    aliases: ["render", "save png", "save jpeg"],
    tags: ["export", "file", "png", "jpeg"],
    inputSchema: object(
      {
        path,
        format: string("Output format.", { enum: ["png", "jpeg"], default: "png" }),
        quality: number("JPEG quality from 0 to 1.", { minimum: 0, maximum: 1, default: 0.85 }),
        background: hexColor("JPEG background as a six-digit hex colour.", { default: "#FFFFFF" }),
      },
      ["path"],
    ),
    examples: [
      { arguments: { path: "/Users/me/Pictures/final.png", format: "png" } },
      { arguments: { path: "/Users/me/Pictures/final.jpg", format: "jpeg", quality: 0.9, background: "#FFFFFF" } },
    ],
  }),
  capability({
    name: "document.resizeCanvas",
    title: "Resize canvas",
    description: "Change canvas bounds and anchor without scaling layer pixels.",
    category: "document",
    aliases: ["canvas size", "expand canvas", "change canvas size"],
    tags: ["canvas", "resize", "anchor"],
    inputSchema: object(
      {
        width: number("New width in pixels.", { minimum: 1, maximum: 30000 }),
        height: number("New height in pixels.", { minimum: 1, maximum: 30000 }),
        anchor: string("Anchor position.", {
          enum: ["top-left", "top", "top-right", "left", "centre", "right", "bottom-left", "bottom", "bottom-right"],
          default: "centre",
        }),
      },
      ["width", "height"],
    ),
    examples: [{ arguments: { width: 1920, height: 1080, anchor: "top-left" } }],
  }),
  capability({
    name: "document.resizeImage",
    title: "Resize image",
    description:
      "Resample the whole document to explicit pixel dimensions and optional resolution. Height is required — there is no proportional auto-height, so compute it from the current aspect ratio when preserving shape.",
    category: "document",
    aliases: ["resample image", "scale image", "change image size"],
    tags: ["image size", "resample"],
    inputSchema: object(
      {
        width: number("New width in pixels.", { minimum: 1, maximum: 30000 }),
        height: number("New height in pixels.", { minimum: 1, maximum: 30000 }),
        resolution: number("Optional DPI.", { minimum: 1, maximum: 2400 }),
      },
      ["width", "height"],
    ),
    examples: [{ arguments: { width: 1024, height: 768, resolution: 144 } }],
  }),
  capability({
    name: "document.crop",
    title: "Crop document",
    description: "Crop or expand the document to an explicit rectangle.",
    category: "document",
    risk: "destructive",
    aliases: ["crop", "trim canvas"],
    tags: ["crop", "canvas", "bounds"],
    inputSchema: object(
      {
        x: number("Left coordinate in document pixels."),
        y: number("Top coordinate in document pixels."),
        width: number("Crop width.", { minimum: 1 }),
        height: number("Crop height.", { minimum: 1 }),
      },
      ["x", "y", "width", "height"],
    ),
    examples: [{ arguments: { x: 64, y: 64, width: 512, height: 512 } }],
  }),
  capability({
    name: "document.flip",
    title: "Flip canvas",
    description: "Flip the entire canvas horizontally or vertically.",
    category: "document",
    inputSchema: object({ axis: string("Flip axis.", { enum: ["horizontal", "vertical"] }) }, ["axis"]),
  }),
  capability({
    name: "history.undo",
    title: "Undo",
    description: "Undo the most recent document edit.",
    category: "history",
    risk: "write",
    transactional: false,
    aliases: ["revert last edit"],
  }),
  capability({
    name: "history.redo",
    title: "Redo",
    description: "Redo the most recently undone document edit.",
    category: "history",
    risk: "write",
    transactional: false,
  }),
  capability({
    name: "layer.list",
    title: "List layers",
    description: "Return the current document's layer stack, groups, masks and transforms.",
    category: "layer",
    risk: "read",
    transactional: false,
    aliases: ["inspect layers", "layer tree"],
    inputSchema: object({ projectId }),
  }),
  capability({
    name: "layer.select",
    title: "Select layers",
    description: "Select one or more layers and optionally target the active layer's mask.",
    category: "layer",
    inputSchema: object(
      {
        layerIds: { type: "array", items: layerId, minItems: 1, maxItems: 100 },
        target: string("Select layer pixels or its mask.", { enum: ["layer", "mask"], default: "layer" }),
      },
      ["layerIds"],
    ),
    examples: [{ arguments: { layerIds: ["active"], target: "layer" } }],
  }),
  capability({
    name: "layer.addBlank",
    title: "Add blank layer",
    description: "Insert a transparent layer above the active layer or inside the active group.",
    category: "layer",
    inputSchema: object({ name: string("Optional layer name.") }),
    examples: [{ arguments: { name: "Retouch" } }],
  }),
  capability({
    name: "layer.duplicate",
    title: "Duplicate layer",
    description: "Duplicate the active layer, preserving pixels, masks and appearance.",
    category: "layer",
    inputSchema: object({ layerId }),
  }),
  capability({
    name: "layer.rename",
    title: "Rename layer",
    description: "Rename a layer or group.",
    category: "layer",
    inputSchema: object({ layerId, name: string("New non-empty name.", { minLength: 1, maxLength: 200 }) }, ["layerId", "name"]),
  }),
  capability({
    name: "layer.delete",
    title: "Delete layer",
    description: "Delete a layer or group and its descendants.",
    category: "layer",
    risk: "destructive",
    aliases: ["remove layer"],
    inputSchema: object({ layerId }, ["layerId"]),
  }),
  capability({
    name: "layer.setVisibility",
    title: "Set layer visibility",
    description: "Show or hide a layer or group.",
    category: "layer",
    inputSchema: object({ layerId, visible: boolean("Whether the layer is visible.") }, ["layerId", "visible"]),
  }),
  capability({
    name: "layer.setOpacity",
    title: "Set layer opacity",
    description: "Set layer or adjustment opacity from 0 to 1, including transparency and alpha.",
    category: "layer",
    aliases: ["change transparency", "make transparent", "half transparent", "set alpha"],
    tags: ["opacity", "transparent", "transparency", "alpha"],
    inputSchema: object({ layerId, opacity: number("Opacity from 0 to 1.", { minimum: 0, maximum: 1 }) }, ["layerId", "opacity"]),
    examples: [{ arguments: { layerId: "active", opacity: 0.65 } }],
  }),
  capability({
    name: "layer.setBlendMode",
    title: "Set blend mode",
    description: "Set a layer's Compositor blend mode by display name.",
    category: "layer",
    inputSchema: object(
      {
        layerId,
        blendMode: string("Blend mode.", {
          enum: [
            "Normal", "Multiply", "Screen", "Overlay", "Darken", "Lighten", "Difference",
            "Color Dodge", "Color Burn", "Hue", "Saturation", "Color", "Luminosity",
          ],
        }),
      },
      ["layerId", "blendMode"],
    ),
  }),
  capability({
    name: "layer.move",
    title: "Move layer in stack",
    description: "Move a layer up or down by a relative number of stack positions.",
    category: "layer",
    inputSchema: object(
      {
        layerId,
        offset: integer("Signed stack offset; positive moves up.", { minimum: -1000, maximum: 1000 }),
      },
      ["layerId", "offset"],
    ),
  }),
  capability({
    name: "layer.group",
    title: "Group selected layers",
    description: "Place the selected layers in a new folder.",
    category: "layer",
    inputSchema: object({ name: string("Optional group name.") }),
  }),
  capability({
    name: "layer.ungroup",
    title: "Ungroup layer folder",
    description: "Move a folder's children out and remove the folder.",
    category: "layer",
    aliases: ["dissolve group", "ungroup layers"],
    tags: ["group", "folder"],
    inputSchema: object({ layerId }, ["layerId"]),
    examples: [{ arguments: { layerId: "active" } }],
  }),
  capability({
    name: "layer.merge",
    title: "Merge layers",
    description: "Run Compositor's context-sensitive merge down, merge selected layers or merge group action.",
    category: "layer",
    risk: "destructive",
    inputSchema: object({ layerId }),
  }),
  capability({
    name: "layer.flip",
    title: "Flip layer",
    description: "Flip the selected layer or transform group horizontally or vertically.",
    category: "layer",
    inputSchema: object({ axis: string("Flip axis.", { enum: ["horizontal", "vertical"] }) }, ["axis"]),
  }),
  capability({
    name: "layer.transform",
    title: "Transform layer",
    description: "Set absolute position, size, rotation, flips or sampling for a layer or selected transform group.",
    category: "layer",
    tags: ["move", "scale", "rotate"],
    inputSchema: object(
      {
        layerId,
        x: number("Left coordinate in document pixels."),
        y: number("Top coordinate in document pixels."),
        width: number("Placed width in pixels.", { minimum: 1, maximum: 300000 }),
        height: number("Placed height in pixels.", { minimum: 1, maximum: 300000 }),
        rotation: number("Clockwise degrees."),
        flipX: boolean("Horizontal flip."),
        flipY: boolean("Vertical flip."),
        sampling: string("Sampling quality.", { enum: ["Nearest", "Smooth", "High quality"] }),
      },
      ["layerId"],
    ),
    examples: [{ arguments: { layerId: "active", x: 120, y: 90, width: 800, height: 600, rotation: 5 } }],
  }),
  capability({
    name: "layer.distort",
    title: "Free distort layer",
    description: "Place a layer using four document-space corner points.",
    category: "layer",
    aliases: ["free distort", "perspective transform", "warp corners"],
    tags: ["transform", "distort", "perspective"],
    inputSchema: object(
      {
        layerId,
        corners: {
          type: "array",
          minItems: 4,
          maxItems: 4,
          items: object({ x: number("X coordinate."), y: number("Y coordinate.") }, ["x", "y"]),
        },
      },
      ["layerId", "corners"],
    ),
    examples: [
      {
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
  }),
  capability({
    name: "layer.addMask",
    title: "Add layer mask",
    description: "Add a reveal-all or hide-all mask, or consume the current selection using Compositor semantics.",
    category: "mask",
    inputSchema: object(
      {
        layerId,
        mode: string("Mask creation mode.", { enum: ["reveal", "hide", "from-selection"], default: "reveal" }),
      },
      ["layerId"],
    ),
  }),
  capability({
    name: "layer.deleteMask",
    title: "Delete layer mask",
    description: "Delete the selected layer's mask.",
    category: "mask",
    risk: "destructive",
    inputSchema: object({ layerId }, ["layerId"]),
  }),
  capability({
    name: "layer.setMaskLinked",
    title: "Link or unlink mask",
    description: "Choose whether the layer and its mask transform together.",
    category: "mask",
    inputSchema: object({ layerId, linked: boolean("Whether the mask is linked.") }, ["layerId", "linked"]),
  }),
  capability({
    name: "layer.setClippingMask",
    title: "Set clipping mask",
    description: "Create or release a clipping-mask relationship for a layer.",
    category: "mask",
    inputSchema: object({ layerId, enabled: boolean("Whether clipping is enabled.") }, ["layerId", "enabled"]),
  }),
  capability({
    name: "layer.featherMask",
    title: "Feather layer mask",
    description: "Feather a layer mask by a pixel radius.",
    category: "mask",
    aliases: ["soften mask", "feather mask edge", "blur mask"],
    tags: ["feather", "mask"],
    inputSchema: object({ layerId, radius: number("Feather radius in pixels.", { minimum: 0, maximum: 10000 }) }, ["layerId", "radius"]),
    examples: [{ arguments: { layerId: "active", radius: 12 } }],
  }),
  capability({
    name: "selection.get",
    title: "Get selection",
    description: "Return whether a selection exists and its document-space bounds.",
    category: "selection",
    risk: "read",
    transactional: false,
  }),
  capability({
    name: "selection.all",
    title: "Select all",
    description: "Select the full document canvas.",
    category: "selection",
  }),
  capability({
    name: "selection.none",
    title: "Deselect",
    description: "Clear the current selection outline.",
    category: "selection",
    aliases: ["deselect"],
  }),
  capability({
    name: "selection.invert",
    title: "Invert selection",
    description: "Select all currently unselected canvas pixels and deselect the selected pixels.",
    category: "selection",
  }),
  capability({
    name: "selection.fromLayer",
    title: "Select layer pixels",
    description: "Load a layer's non-transparent pixels as the selection.",
    category: "selection",
    inputSchema: object({ layerId }, ["layerId"]),
  }),
  capability({
    name: "selection.fromMask",
    title: "Select mask areas",
    description: "Load a layer mask's black areas as the selection.",
    category: "selection",
    inputSchema: object({ layerId }, ["layerId"]),
  }),
  capability({
    name: "selection.rectangle",
    title: "Rectangular selection",
    description: "Create, add to or subtract a rectangular selection.",
    category: "selection",
    aliases: ["marquee", "rectangular marquee", "select rectangle"],
    tags: ["marquee", "rectangle"],
    inputSchema: marqueeRect,
    examples: [{ arguments: { x: 40, y: 40, width: 400, height: 300, mode: "replace" } }],
  }),
  capability({
    name: "selection.ellipse",
    title: "Elliptical selection",
    description: "Create, add to or subtract an elliptical selection.",
    category: "selection",
    aliases: ["elliptical marquee", "select ellipse", "circular selection"],
    tags: ["marquee", "ellipse"],
    inputSchema: marqueeRect,
    examples: [{ arguments: { x: 100, y: 100, width: 300, height: 300, mode: "add" } }],
  }),
  capability({
    name: "selection.polygon",
    title: "Polygonal selection",
    description: "Create a polygonal lasso selection from document-space points.",
    category: "selection",
    aliases: ["lasso", "polygonal lasso", "select polygon"],
    tags: ["lasso", "polygon"],
    inputSchema: object(
      {
        points: {
          type: "array", minItems: 3, maxItems: 10000,
          items: object({ x: number("X coordinate."), y: number("Y coordinate.") }, ["x", "y"]),
        },
        mode: selectionMode,
      },
      ["points"],
    ),
    examples: [
      {
        arguments: {
          points: [
            { x: 120, y: 80 },
            { x: 260, y: 60 },
            { x: 300, y: 220 },
            { x: 150, y: 260 },
          ],
        },
      },
    ],
  }),
  capability({
    name: "selection.magicWand",
    title: "Magic Wand selection",
    description: "Select similar pixels around a document-space point.",
    category: "selection",
    aliases: ["wand", "select similar", "select by colour"],
    tags: ["wand", "tolerance"],
    inputSchema: object(
      {
        x: number("X coordinate."), y: number("Y coordinate."),
        tolerance: number("Colour tolerance.", { minimum: 0, maximum: 255, default: 32 }),
        contiguous: boolean("Restrict selection to connected pixels.", true),
        sampleSize: string("How much of the image around the point is averaged into the sampled colour.", {
          enum: ["Point Sample", "3 by 3 Average", "5 by 5 Average"],
          default: "Point Sample",
        }),
        sampleAllLayers: boolean("Sample the visible composite instead of only the active layer.", false),
        mode: selectionMode,
      },
      ["x", "y"],
    ),
    examples: [{ arguments: { x: 320, y: 200, tolerance: 24, contiguous: true, sampleAllLayers: true } }],
  }),
  capability({
    name: "selection.expand",
    title: "Expand selection",
    description: "Grow the selection by a pixel radius.",
    category: "selection",
    inputSchema: object({ pixels: integer("Expansion in pixels.", { minimum: 1, maximum: 500 }) }, ["pixels"]),
  }),
  capability({
    name: "selection.contract",
    title: "Contract selection",
    description: "Shrink the selection by a pixel radius.",
    category: "selection",
    inputSchema: object({ pixels: integer("Contraction in pixels.", { minimum: 1, maximum: 500 }) }, ["pixels"]),
  }),
  capability({
    name: "pixels.fill",
    title: "Fill pixels",
    description: "Fill the current selection, or the whole active layer when no selection exists, with foreground or background colour.",
    category: "pixels",
    inputSchema: object(
      {
        target: string("Fill colour source.", { enum: ["foreground", "background"], default: "foreground" }),
      },
    ),
  }),
  capability({
    name: "pixels.clear",
    title: "Clear pixels",
    description: "Clear pixels inside the current selection on the active layer or mask.",
    category: "pixels",
    risk: "destructive",
  }),
  capability({
    name: "pixels.invert",
    title: "Invert pixels or mask",
    description: "Invert RGB pixels, preserving transparency, or invert the selected mask.",
    category: "pixels",
  }),
  capability({
    name: "pixels.contentAwareFill",
    title: "Content-aware fill",
    description: "Fill the current selection using surrounding image content, including past layer edges.",
    category: "pixels",
    risk: "write",
    aliases: ["content aware fill", "fill selection", "generative fill"],
    tags: ["fill", "retouch"],
    examples: [{ arguments: {} }],
  }),
  capability({
    name: "paint.brushStroke",
    title: "Paint brush stroke",
    description: "Paint or erase along a document-space point path with explicit brush settings.",
    category: "paint",
    aliases: ["brush", "paint", "draw", "erase"],
    tags: ["brush", "stroke", "draw"],
    inputSchema: object(
      {
        mode: string("Stroke mode.", { enum: ["paint", "erase"], default: "paint" }),
        points: strokePoints("Document-space stroke path."),
        diameter: brushDiameter,
        hardness: brushHardness,
        opacity: brushOpacity,
        color: hexColor("Paint colour; defaults to the foreground colour."),
      },
      ["points"],
    ),
    examples: [
      {
        arguments: {
          points: [
            { x: 40, y: 40 },
            { x: 120, y: 90 },
            { x: 200, y: 60 },
          ],
          diameter: 24,
          hardness: 0.8,
          opacity: 0.9,
        },
      },
    ],
  }),
  capability({
    name: "paint.spotHeal",
    title: "Spot-heal stroke",
    description: "Run the content-aware spot healing brush along a point path.",
    category: "paint",
    aliases: ["heal", "spot healing", "remove blemish"],
    tags: ["retouch", "heal"],
    inputSchema: object(
      {
        points: strokePoints("Document-space healing path."),
        diameter: brushDiameter,
        hardness: brushHardness,
        opacity: brushOpacity,
        mode: string("Spot healing mode.", {
          enum: ["Content-Aware", "Create Texture", "Proximity Match"],
          default: "Content-Aware",
        }),
      },
      ["points"],
    ),
    examples: [
      {
        arguments: {
          points: [
            { x: 120, y: 80 },
            { x: 150, y: 110 },
          ],
          diameter: 24,
          mode: "Content-Aware",
        },
      },
    ],
  }),
  capability({
    name: "paint.clone",
    title: "Clone-stamp stroke",
    description: "Clone from a source point along a destination path.",
    category: "paint",
    aliases: ["clone stamp", "clone source", "stamp"],
    tags: ["retouch", "clone"],
    inputSchema: object(
      {
        source: { ...point, description: "Document-space point the stroke samples from." },
        points: strokePoints("Document-space destination path."),
        aligned: boolean("Keep the sample offset between strokes; off re-samples from the source each stroke.", true),
        sampleAllLayers: boolean("Sample all visible layers instead of only the active layer.", false),
        diameter: brushDiameter,
        hardness: brushHardness,
        opacity: brushOpacity,
      },
      ["source", "points"],
    ),
    examples: [
      {
        arguments: {
          source: { x: 100, y: 100 },
          points: [
            { x: 400, y: 300 },
            { x: 460, y: 320 },
          ],
          aligned: true,
          sampleAllLayers: false,
          diameter: 40,
        },
      },
    ],
  }),
  capability({
    name: "paint.blur",
    title: "Blur or liquify stroke",
    description: "Apply Compositor's blur, smudge or liquify brush along a path.",
    category: "paint",
    aliases: ["smudge", "liquify", "blur brush", "smear"],
    tags: ["warp", "smudge", "liquify"],
    inputSchema: object(
      {
        mode: string("Warp tool mode.", { enum: ["Blur", "Smudge", "Liquify"], default: "Blur" }),
        points: strokePoints("Document-space stroke path."),
        diameter: brushDiameter,
        hardness: brushHardness,
        strength: number("Stroke strength from 0.01 to 1.", { minimum: 0.01, maximum: 1, default: 1 }),
      },
      ["points"],
    ),
    examples: [
      {
        arguments: {
          mode: "Smudge",
          points: [
            { x: 200, y: 200 },
            { x: 280, y: 240 },
          ],
          diameter: 60,
          strength: 0.5,
        },
      },
    ],
  }),
  capability({
    name: "paint.gradient",
    title: "Apply gradient",
    description: "Apply a configured gradient between two document-space points.",
    category: "paint",
    aliases: ["gradient fill", "draw gradient"],
    tags: ["gradient", "fill"],
    inputSchema: object(
      {
        start: { ...point, description: "Gradient start point in document pixels." },
        end: { ...point, description: "Gradient end point in document pixels." },
        shape: string("Gradient shape.", { enum: ["Linear", "Radial"], default: "Linear" }),
        style: string("Gradient style.", {
          enum: ["Foreground to Background", "Foreground to Transparent"],
          default: "Foreground to Transparent",
        }),
        stops: {
          type: "array",
          description: "Explicit colour stops ordered by offset; overrides style when present.",
          items: object(
            {
              offset: number("Stop position from 0 to 1.", { minimum: 0, maximum: 1 }),
              color: hexColor("Stop colour."),
            },
            ["offset", "color"],
          ),
          minItems: 2,
          maxItems: 32,
        },
        reversed: boolean("Reverse the gradient direction.", false),
        opacity: number("Gradient opacity from 0 to 1.", { minimum: 0, maximum: 1, default: 1 }),
      },
      ["start", "end"],
    ),
    examples: [
      {
        arguments: {
          start: { x: 100, y: 100 },
          end: { x: 700, y: 500 },
          shape: "Linear",
          style: "Foreground to Transparent",
        },
      },
      {
        arguments: {
          start: { x: 400, y: 300 },
          end: { x: 600, y: 300 },
          shape: "Radial",
          stops: [
            { offset: 0, color: "#FF8800" },
            { offset: 1, color: "#0033FF" },
          ],
        },
        note: "Explicit colour stops override style.",
      },
    ],
  }),
  capability({
    name: "paint.shape",
    title: "Draw shape",
    description: "Create a rectangle, rounded rectangle or ellipse shape layer.",
    category: "paint",
    aliases: ["draw shape", "rectangle", "ellipse", "rounded rectangle"],
    tags: ["shape", "vector"],
    inputSchema: object(
      {
        kind: string("Shape kind.", { enum: ["Rectangle", "Ellipse"], default: "Rectangle" }),
        x: number("Left coordinate in document pixels."),
        y: number("Top coordinate in document pixels."),
        width: number("Shape width in pixels.", { minimum: 1, maximum: 30000 }),
        height: number("Shape height in pixels.", { minimum: 1, maximum: 30000 }),
        cornerRadius: number("Corner radius in document pixels; rectangles only.", {
          minimum: 0,
          maximum: 15000,
          default: 0,
        }),
        color: hexColor("Fill colour; defaults to the foreground colour."),
        name: string("Optional name for the new shape layer."),
      },
      ["x", "y", "width", "height"],
    ),
    examples: [
      {
        arguments: { kind: "Rectangle", x: 50, y: 50, width: 200, height: 120, cornerRadius: 16, color: "#3366FF" },
      },
    ],
  }),
  capability({
    name: "adjustment.add",
    title: "Add adjustment layer",
    description: "Add Levels, Curves, Hue/Saturation, Exposure, Gradient Map or Grain adjustment layer.",
    category: "adjustment",
    aliases: ["new adjustment", "adjustment layer"],
    tags: ["non-destructive", "colour", "levels", "curves"],
    inputSchema: {
      type: "object",
      description: "An adjustment kind plus optional typed parameters; each kind accepts only its own parameter set.",
      oneOf: ADJUSTMENT_PARAMETERS.map(([kind, parameters]) =>
        object(
          {
            kind: kindConst(kind, "Adjustment kind."),
            name: string("Optional name for the new adjustment layer."),
            parameters,
          },
          ["kind"],
        ),
      ),
    },
    examples: [
      { arguments: { kind: "Exposure", name: "Brighten", parameters: { exposure: 0.7, gamma: 1.1 } } },
      { arguments: { kind: "Hue/Saturation", parameters: { saturation: -40 } } },
    ],
  }),
  capability({
    name: "adjustment.update",
    title: "Update adjustment layer",
    description: "Update an adjustment layer with typed parameters.",
    category: "adjustment",
    aliases: ["edit adjustment", "change adjustment"],
    tags: ["non-destructive", "colour"],
    inputSchema: {
      type: "object",
      description:
        "An adjustment layer id, its kind and the typed parameters to update; each kind accepts only its own parameter set.",
      oneOf: ADJUSTMENT_PARAMETERS.map(([kind, parameters]) =>
        object(
          {
            layerId,
            kind: kindConst(kind, "Adjustment kind; must match the layer's own kind."),
            parameters,
          },
          ["layerId", "kind", "parameters"],
        ),
      ),
    },
    examples: [{ arguments: { layerId: "active", kind: "Grain", parameters: { amount: 60, size: 2 } } }],
  }),
  capability({
    name: "filter.apply",
    title: "Apply image filter",
    description: "Apply Gaussian Blur, Motion Blur, Add Noise, Lens Correction, Remove Background or supported colour adjustment.",
    category: "filter",
    aliases: ["apply filter", "gaussian blur", "remove background"],
    tags: ["filter", "blur", "noise", "background"],
    inputSchema: {
      type: "object",
      description: "A filter kind plus optional settings; each kind accepts only its own FilterSettings fields.",
      oneOf: FILTER_SETTINGS.map(([kind, settings]) =>
        object(
          {
            kind: kindConst(kind, "Filter kind."),
            settings,
          },
          ["kind"],
        ),
      ),
    },
    examples: [
      { arguments: { kind: "Gaussian Blur", settings: { radius: 4 } } },
      { arguments: { kind: "Remove Background", settings: { backgroundQuality: "Advanced", refineEdges: 20 } } },
    ],
  }),
  capability({
    name: "preview.render",
    title: "Render preview",
    description: "Render the current document to a temporary full-resolution PNG and return its path and dimensions.",
    category: "preview",
    risk: "filesystem",
    transactional: false,
    aliases: ["screenshot", "thumbnail"],
    tags: ["render", "inspect"],
  }),
] as const;

const names = new Set<string>();
for (const entry of CAPABILITIES) {
  if (names.has(entry.name)) throw new Error(`Duplicate capability: ${entry.name}`);
  names.add(entry.name);
}

export const CAPABILITY_BY_NAME = new Map(CAPABILITIES.map((entry) => [entry.name, entry]));
