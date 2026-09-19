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
        background: string("JPEG background as a six-digit hex colour.", { pattern: "^#[0-9A-Fa-f]{6}$", default: "#FFFFFF" }),
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
    status: "planned",
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
  }),
  capability({
    name: "document.resizeImage",
    title: "Resize image",
    description: "Resample the whole document to a new pixel size and optional resolution.",
    category: "document",
    status: "planned",
    tags: ["image size", "resample"],
    inputSchema: object(
      {
        width: number("New width in pixels.", { minimum: 1, maximum: 30000 }),
        height: number("New height in pixels.", { minimum: 1, maximum: 30000 }),
        resolution: number("Optional DPI.", { minimum: 1, maximum: 2400 }),
      },
      ["width", "height"],
    ),
  }),
  capability({
    name: "document.crop",
    title: "Crop document",
    description: "Crop or expand the document to an explicit rectangle.",
    category: "document",
    status: "planned",
    inputSchema: object(
      {
        x: number("Left coordinate in document pixels."),
        y: number("Top coordinate in document pixels."),
        width: number("Crop width.", { minimum: 1 }),
        height: number("Crop height.", { minimum: 1 }),
      },
      ["x", "y", "width", "height"],
    ),
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
    status: "planned",
    inputSchema: object({ layerId }, ["layerId"]),
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
    status: "planned",
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
    status: "planned",
    inputSchema: object({ layerId, radius: number("Feather radius in pixels.", { minimum: 0, maximum: 10000 }) }, ["layerId", "radius"]),
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
    status: "planned",
    inputSchema: object(
      {
        x: number("Left coordinate."), y: number("Top coordinate."),
        width: number("Width.", { minimum: 1 }), height: number("Height.", { minimum: 1 }),
        mode: string("Selection combination mode.", { enum: ["replace", "add", "subtract"], default: "replace" }),
      },
      ["x", "y", "width", "height"],
    ),
  }),
  capability({
    name: "selection.ellipse",
    title: "Elliptical selection",
    description: "Create, add to or subtract an elliptical selection.",
    category: "selection",
    status: "planned",
    inputSchema: object(
      {
        x: number("Left coordinate."), y: number("Top coordinate."),
        width: number("Width.", { minimum: 1 }), height: number("Height.", { minimum: 1 }),
        mode: string("Selection combination mode.", { enum: ["replace", "add", "subtract"], default: "replace" }),
      },
      ["x", "y", "width", "height"],
    ),
  }),
  capability({
    name: "selection.polygon",
    title: "Polygonal selection",
    description: "Create a polygonal lasso selection from document-space points.",
    category: "selection",
    status: "planned",
    inputSchema: object(
      {
        points: {
          type: "array", minItems: 3, maxItems: 10000,
          items: object({ x: number("X coordinate."), y: number("Y coordinate.") }, ["x", "y"]),
        },
        mode: string("Selection combination mode.", { enum: ["replace", "add", "subtract"], default: "replace" }),
      },
      ["points"],
    ),
  }),
  capability({
    name: "selection.magicWand",
    title: "Magic Wand selection",
    description: "Select similar pixels around a document-space point.",
    category: "selection",
    status: "planned",
    inputSchema: object(
      {
        x: number("X coordinate."), y: number("Y coordinate."),
        tolerance: number("Colour tolerance.", { minimum: 0, maximum: 255, default: 32 }),
        contiguous: boolean("Restrict selection to connected pixels.", true),
      },
      ["x", "y"],
    ),
  }),
  capability({
    name: "selection.expand",
    title: "Expand selection",
    description: "Grow the selection by a pixel radius.",
    category: "selection",
    inputSchema: object({ pixels: integer("Expansion in pixels.", { minimum: 1, maximum: 10000 }) }, ["pixels"]),
  }),
  capability({
    name: "selection.contract",
    title: "Contract selection",
    description: "Shrink the selection by a pixel radius.",
    category: "selection",
    inputSchema: object({ pixels: integer("Contraction in pixels.", { minimum: 1, maximum: 10000 }) }, ["pixels"]),
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
    status: "planned",
    risk: "write",
  }),
  capability({
    name: "paint.brushStroke",
    title: "Paint brush stroke",
    description: "Paint or erase along a document-space point path with explicit brush settings.",
    category: "paint",
    status: "planned",
    inputSchema: object(
      {
        mode: string("Stroke mode.", { enum: ["paint", "erase"], default: "paint" }),
        points: {
          type: "array", minItems: 1, maxItems: 100000,
          items: object({ x: number("X coordinate."), y: number("Y coordinate."), pressure: number("Pressure from 0 to 1.", { minimum: 0, maximum: 1 }) }, ["x", "y"]),
        },
        size: number("Brush diameter in pixels.", { minimum: 1, maximum: 10000 }),
        hardness: number("Brush hardness from 0 to 1.", { minimum: 0, maximum: 1 }),
        opacity: number("Brush opacity from 0 to 1.", { minimum: 0, maximum: 1 }),
      },
      ["points", "size", "hardness", "opacity"],
    ),
  }),
  capability({
    name: "paint.spotHeal",
    title: "Spot-heal stroke",
    description: "Run the content-aware spot healing brush along a point path.",
    category: "paint",
    status: "planned",
  }),
  capability({
    name: "paint.clone",
    title: "Clone-stamp stroke",
    description: "Clone from a source point along a destination path.",
    category: "paint",
    status: "planned",
  }),
  capability({
    name: "paint.blur",
    title: "Blur or liquify stroke",
    description: "Apply Compositor's blur, smudge or liquify brush along a path.",
    category: "paint",
    status: "planned",
  }),
  capability({
    name: "paint.gradient",
    title: "Apply gradient",
    description: "Apply a configured gradient between two document-space points.",
    category: "paint",
    status: "planned",
  }),
  capability({
    name: "paint.shape",
    title: "Draw shape",
    description: "Create a rectangle, rounded rectangle or ellipse shape layer.",
    category: "paint",
    status: "planned",
  }),
  capability({
    name: "adjustment.add",
    title: "Add adjustment layer",
    description: "Add Levels, Curves, Hue/Saturation, Exposure, Gradient Map or Grain adjustment layer.",
    category: "adjustment",
    status: "planned",
  }),
  capability({
    name: "adjustment.update",
    title: "Update adjustment layer",
    description: "Update an adjustment layer with typed parameters.",
    category: "adjustment",
    status: "planned",
  }),
  capability({
    name: "filter.apply",
    title: "Apply image filter",
    description: "Apply Gaussian Blur, Motion Blur, Add Noise, Lens Correction, Remove Background or supported colour adjustment.",
    category: "filter",
    status: "planned",
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
