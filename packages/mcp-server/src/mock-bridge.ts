import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CAPABILITIES,
  isJsonObject,
  type BridgeRequest,
  type ExecuteRequest,
  type JsonObject,
  type JsonValue,
  type Operation,
  type OperationResult,
} from "@compositor-mcp/protocol";
import { CompositorMcpError } from "./errors.js";
import type { BridgeTransport } from "./bridge-client.js";
import { PREVIEW_DIRECTORY } from "./resources.js";

/// A real 1×1 opaque PNG. The mock writes it to the same temp-directory
/// convention the bridge uses so the inline-image path and
/// compositor://preview/latest are exercised end to end.
const MOCK_PREVIEW_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export interface MockLayer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blendMode: string;
  parentId: string | null;
  group: boolean;
  transform: { x: number; y: number; width: number; height: number; rotation: number; flipX: boolean; flipY: boolean; sampling: string };
  mask: boolean;
  /** True for layers created by paint.shape, like the real state builder's `shape` flag. */
  shape: boolean;
  /** True for layers created by adjustment.add, like the real state builder's `adjustment` flag. */
  adjustment: boolean;
  /** The adjustment's AdjustmentKind raw value when adjustment is true, else null. */
  adjustmentKind: string | null;
  /** Last supplied adjustment parameters, retained so adjustment.update merges onto them. */
  adjustmentParameters: JsonObject | null;
  /** Bounds of the last pixels.fill or paint.* stroke, approximating painted coverage; null when never painted. */
  fill: MockSelection | null;
}

export interface MockSelection {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MockDocument {
  id: string;
  width: number;
  height: number;
  resolution: number;
  layers: MockLayer[];
  activeLayerId: string | null;
  selectedLayerIds: string[];
  /** Document-space selection bounds; null means no selection. */
  selection: MockSelection | null;
}

export class MockBridgeTransport implements BridgeTransport {
  private revision = 0;
  private document: MockDocument | null = null;
  private previewImage: Buffer;

  constructor(options: { previewImage?: Buffer } = {}) {
    this.previewImage = options.previewImage ?? MOCK_PREVIEW_PNG;
  }

  async request(method: BridgeRequest["method"], params?: JsonObject): Promise<JsonValue> {
    switch (method) {
      case "ping":
        return { ok: true, mock: true, revision: this.revision };
      case "capabilities":
        // Same envelope the real router answers — { protocol, implemented,
        // revision } — with the full catalogue attached for the
        // compositor://capabilities resource.
        return {
          protocol: "compositor-bridge/1",
          implemented: CAPABILITIES.filter((capability) => capability.status === "implemented")
            .map((capability) => capability.name)
            .sort(),
          revision: this.revision,
          catalogue: CAPABILITIES,
        } as unknown as JsonValue;
      case "state":
        return this.state();
      case "execute":
        return this.execute((params ?? {}) as unknown as ExecuteRequest);
      default: {
        const exhaustive: never = method;
        throw new CompositorMcpError("unsupported_method", `Unsupported mock method: ${String(exhaustive)}`);
      }
    }
  }

  private state(): JsonValue {
    return {
      mock: true,
      revision: this.revision,
      projects: [
        {
          id: "mock-project",
          title: this.document ? "Mock document" : "Untitled",
          selected: true,
          modified: this.revision > 0,
        },
      ],
      current: this.document,
    } as unknown as JsonValue;
  }

  private async execute(request: ExecuteRequest): Promise<JsonValue> {
    const operations = request.operations ?? [];
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new CompositorMcpError("invalid_request", "At least one operation is required.");
    }

    if (request.dryRun) {
      return {
        ok: true,
        dryRun: true,
        atomic: request.atomic ?? true,
        results: operations.map((operation, index) => ({ index, name: operation.name, ok: true, value: { valid: true } })),
        state: this.state(),
      } as unknown as JsonValue;
    }

    const before = structuredClone(this.document);
    const beforeRevision = this.revision;
    const results: OperationResult[] = [];
    let failed = false;

    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      if (!operation) continue;
      try {
        const value = await this.apply(operation);
        results.push({ index, name: operation.name, ok: true, value });
      } catch (error) {
        const normalised = error instanceof CompositorMcpError ? error.toJSON() : { code: "mock_error", message: String(error) };
        results.push({ index, name: operation.name, ok: false, error: normalised });
        failed = true;
        if (request.atomic ?? true) break;
      }
    }

    let rolledBack = false;
    if (failed && (request.atomic ?? true)) {
      this.document = before;
      this.revision = beforeRevision;
      rolledBack = true;
    }

    return {
      ok: !failed,
      dryRun: false,
      atomic: request.atomic ?? true,
      rolledBack,
      mutated: this.revision !== beforeRevision,
      revision: this.revision,
      results,
      state: this.state(),
    } as unknown as JsonValue;
  }

  private async apply(operation: Operation): Promise<JsonValue> {
    const args = operation.arguments ?? {};
    switch (operation.name) {
      case "app.ping":
        return { ok: true, mock: true };
      case "app.getState":
      case "workspace.list":
      case "layer.list":
        return this.state();
      case "selection.get":
        return this.selectionValue();
      case "document.create": {
        const width = requiredNumber(args, "width");
        const height = requiredNumber(args, "height");
        this.document = {
          id: randomUUID(),
          width,
          height,
          resolution: optionalNumber(args, "resolution") ?? 72,
          layers: [],
          activeLayerId: null,
          selectedLayerIds: [],
          selection: null,
        };
        this.revision += 1;
        return { documentId: this.document.id };
      }
      case "document.crop": {
        const document = this.requireDocument();
        const x = requiredNumber(args, "x");
        const y = requiredNumber(args, "y");
        const width = requiredNumber(args, "width");
        const height = requiredNumber(args, "height");
        // Mirrors CropGeometry.snapped: whole-pixel bounds.
        const left = Math.round(x);
        const top = Math.round(y);
        const croppedWidth = Math.max(1, Math.round(x + width) - left);
        const croppedHeight = Math.max(1, Math.round(y + height) - top);
        if (croppedWidth > 30_000 || croppedHeight > 30_000 || Math.abs(left) > 1_000_000 || Math.abs(top) > 1_000_000) {
          throw new CompositorMcpError("invalid_arguments", "The crop rectangle is outside Compositor's limits.");
        }
        if (left >= document.width || top >= document.height || left + croppedWidth <= 0 || top + croppedHeight <= 0) {
          throw new CompositorMcpError("invalid_arguments", "The crop rectangle does not intersect the canvas.");
        }
        for (const layer of document.layers) {
          layer.transform.x -= left;
          layer.transform.y -= top;
        }
        document.width = croppedWidth;
        document.height = croppedHeight;
        this.revision += 1;
        return { documentId: document.id, x: left, y: top, width: croppedWidth, height: croppedHeight };
      }
      case "document.resizeCanvas": {
        const document = this.requireDocument();
        const width = requiredNumber(args, "width");
        const height = requiredNumber(args, "height");
        checkBounds(Math.round(width), "Document dimensions", 1, 30_000, " pixels");
        checkBounds(Math.round(height), "Document dimensions", 1, 30_000, " pixels");
        const anchor = optionalString(args, "anchor") ?? "centre";
        const anchorIndex = CANVAS_ANCHORS.indexOf(anchor);
        if (anchorIndex < 0) throw new CompositorMcpError("invalid_arguments", `Unknown anchor: ${anchor}`);
        const dx = Math.floor((Math.round(width) - document.width) * (anchorIndex % 3) / 2);
        const dy = Math.floor((Math.round(height) - document.height) * Math.floor(anchorIndex / 3) / 2);
        for (const layer of document.layers) {
          layer.transform.x += dx;
          layer.transform.y += dy;
        }
        document.width = Math.round(width);
        document.height = Math.round(height);
        this.revision += 1;
        return { documentId: document.id, width: document.width, height: document.height, anchor };
      }
      case "document.resizeImage": {
        const document = this.requireDocument();
        const width = requiredNumber(args, "width");
        const height = requiredNumber(args, "height");
        checkBounds(Math.round(width), "Document dimensions", 1, 30_000, " pixels");
        checkBounds(Math.round(height), "Document dimensions", 1, 30_000, " pixels");
        if (Math.round(width) * Math.round(height) > 100_000_000) {
          throw new CompositorMcpError("invalid_arguments", "This project exceeds the supported canvas, layer, file-size, or 100-megapixel image limit.");
        }
        const resolution = boundedNumber(args, "resolution", 1, 2400, " DPI");
        const sx = Math.round(width) / document.width;
        const sy = Math.round(height) / document.height;
        for (const layer of document.layers) {
          layer.transform.x *= sx;
          layer.transform.y *= sy;
          layer.transform.width *= sx;
          layer.transform.height *= sy;
        }
        document.width = Math.round(width);
        document.height = Math.round(height);
        document.resolution = resolution ?? document.resolution;
        this.revision += 1;
        return { documentId: document.id, width: document.width, height: document.height, resolution: document.resolution };
      }
      case "layer.addBlank": {
        const document = this.requireDocument();
        const layer = mockLayer(document, { name: optionalString(args, "name") ?? `Layer ${document.layers.length + 1}` });
        document.layers.push(layer);
        document.activeLayerId = layer.id;
        document.selectedLayerIds = [layer.id];
        this.revision += 1;
        return layer as unknown as JsonValue;
      }
      case "layer.group": {
        const document = this.requireDocument();
        const selected = new Set(document.selectedLayerIds);
        if (selected.size === 0) throw new CompositorMcpError("layer_required", "Select at least one layer first.");
        let topIndex = -1;
        document.layers.forEach((layer, index) => {
          if (selected.has(layer.id)) topIndex = index;
        });
        const group = mockLayer(document, {
          name: optionalString(args, "name") ?? "Folder 1",
          parentId: document.layers[topIndex]?.parentId ?? null,
          group: true,
        });
        document.layers.splice(topIndex + 1, 0, group);
        for (const layer of document.layers) {
          if (selected.has(layer.id)) layer.parentId = group.id;
        }
        document.activeLayerId = group.id;
        document.selectedLayerIds = [group.id];
        this.revision += 1;
        return group as unknown as JsonValue;
      }
      case "layer.ungroup": {
        const document = this.requireDocument();
        const id = this.resolveLayerId(requiredString(args, "layerId"));
        const group = this.requireLayer(id);
        if (!group.group) throw new CompositorMcpError("invalid_arguments", "The layer is not a group.");
        const siblings = document.layers.filter((layer) => layer.parentId === group.parentId);
        const rank = siblings.findIndex((layer) => layer.id === id);
        const children = document.layers.filter((layer) => layer.parentId === id);
        document.layers = document.layers.filter((layer) => layer.id !== id && layer.parentId !== id);
        for (const child of children) child.parentId = group.parentId;
        let insertion = document.layers.length;
        let seen = 0;
        for (let index = 0; index < document.layers.length; index += 1) {
          if (document.layers[index]!.parentId !== group.parentId) continue;
          if (seen === rank) { insertion = index; break; }
          seen += 1;
        }
        document.layers.splice(insertion, 0, ...children);
        document.activeLayerId = children.length > 0 ? children[children.length - 1]!.id : null;
        document.selectedLayerIds = children.map((child) => child.id);
        this.revision += 1;
        return { ungroupedLayerId: id, childLayerIds: children.map((child) => child.id) };
      }
      case "layer.transform": {
        const layer = this.requireLayer(this.resolveLayerId(requiredString(args, "layerId")));
        for (const key of ["x", "y", "width", "height", "rotation"] as const) {
          const value = optionalNumber(args, key);
          if (value !== undefined) layer.transform[key] = value;
        }
        for (const key of ["flipX", "flipY"] as const) {
          const value = optionalBoolean(args, key);
          if (value !== undefined) layer.transform[key] = value;
        }
        const sampling = optionalString(args, "sampling");
        if (sampling !== undefined) layer.transform.sampling = sampling;
        this.revision += 1;
        return layer as unknown as JsonValue;
      }
      case "layer.distort": {
        const layer = this.requireLayer(this.resolveLayerId(requiredString(args, "layerId")));
        const corners = requiredCorners(args, "corners");
        if (!isUsableDistortCorners(corners)) {
          throw new CompositorMcpError("invalid_arguments", "corners must describe a convex, non-degenerate quadrilateral.");
        }
        const bounds = pointsBounds(corners);
        const left = Math.floor(bounds.left);
        const top = Math.floor(bounds.top);
        layer.transform.x = left;
        layer.transform.y = top;
        layer.transform.width = Math.ceil(bounds.right) - left;
        layer.transform.height = Math.ceil(bounds.bottom) - top;
        layer.transform.rotation = 0;
        this.revision += 1;
        return layer as unknown as JsonValue;
      }
      case "layer.addMask": {
        const layer = this.requireLayer(this.resolveLayerId(requiredString(args, "layerId")));
        const mode = optionalString(args, "mode") ?? "reveal";
        if (!["reveal", "hide", "from-selection"].includes(mode)) {
          throw new CompositorMcpError("invalid_arguments", "mode must be reveal, hide or from-selection.");
        }
        if (layer.mask) throw new CompositorMcpError("mask_exists", "The layer already has a mask.");
        if (mode === "from-selection" && !this.requireDocument().selection) {
          throw new CompositorMcpError("selection_required", "from-selection requires an active selection.");
        }
        layer.mask = true;
        this.revision += 1;
        return layer as unknown as JsonValue;
      }
      case "layer.featherMask": {
        const layer = this.requireLayer(this.resolveLayerId(requiredString(args, "layerId")));
        const radius = requiredNumber(args, "radius");
        checkBounds(radius, "radius", 0, 10_000, " pixels");
        if (!layer.mask) throw new CompositorMcpError("not_found", "Layer mask not found.");
        this.revision += 1;
        return { layerId: layer.id, radius, hasMask: true };
      }
      case "layer.select": {
        const document = this.requireDocument();
        const ids = requiredStringArray(args, "layerIds").map((id) => this.resolveLayerId(id));
        for (const id of ids) this.requireLayer(id);
        document.selectedLayerIds = ids;
        document.activeLayerId = ids.length > 0 ? ids[ids.length - 1] ?? null : null;
        return { selectedLayerIds: ids };
      }
      case "layer.rename": {
        const layer = this.requireLayer(this.resolveLayerId(requiredString(args, "layerId")));
        layer.name = requiredString(args, "name");
        this.revision += 1;
        return layer as unknown as JsonValue;
      }
      case "layer.setOpacity": {
        const layer = this.requireLayer(this.resolveLayerId(requiredString(args, "layerId")));
        layer.opacity = clamp(requiredNumber(args, "opacity"), 0, 1);
        this.revision += 1;
        return { id: layer.id, opacity: layer.opacity };
      }
      case "layer.setVisibility": {
        const layer = this.requireLayer(this.resolveLayerId(requiredString(args, "layerId")));
        layer.visible = requiredBoolean(args, "visible");
        this.revision += 1;
        return { id: layer.id, visible: layer.visible };
      }
      case "layer.delete": {
        const layer = this.requireLayer(this.resolveLayerId(requiredString(args, "layerId")));
        const document = this.requireDocument();
        document.layers.splice(document.layers.indexOf(layer), 1);
        document.activeLayerId = document.layers.length > 0 ? document.layers[document.layers.length - 1]?.id ?? null : null;
        document.selectedLayerIds = document.activeLayerId ? [document.activeLayerId] : [];
        this.revision += 1;
        return { deletedLayerId: layer.id };
      }
      case "selection.all": {
        const document = this.requireDocument();
        document.selection = { x: 0, y: 0, width: document.width, height: document.height };
        this.revision += 1;
        return { selected: true };
      }
      case "selection.none":
        this.requireDocument().selection = null;
        this.revision += 1;
        return { selected: false };
      case "selection.rectangle":
      case "selection.ellipse": {
        const x = requiredNumber(args, "x");
        const y = requiredNumber(args, "y");
        const width = requiredNumber(args, "width");
        const height = requiredNumber(args, "height");
        if (width < 1 || height < 1) {
          throw new CompositorMcpError("invalid_arguments", "width and height must be at least 1.");
        }
        this.combineSelection({ x, y, width, height }, selectionMode(args));
        this.revision += 1;
        return this.selectionValue();
      }
      case "selection.polygon": {
        const points = requiredPoints(args, "points");
        if (points.length < 3) {
          throw new CompositorMcpError("invalid_arguments", "points must be an array of 3 to 10,000 {x, y} points.");
        }
        const bounds = pointsBounds(points);
        this.combineSelection(
          { x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top },
          selectionMode(args),
        );
        this.revision += 1;
        return this.selectionValue();
      }
      case "selection.magicWand": {
        const document = this.requireDocument();
        const x = requiredNumber(args, "x");
        const y = requiredNumber(args, "y");
        if (x < 0 || y < 0 || x >= document.width || y >= document.height) {
          throw new CompositorMcpError("invalid_arguments", "x and y must lie inside the canvas.");
        }
        const tolerance = boundedNumber(args, "tolerance", 0, 255) ?? 32;
        optionalBoolean(args, "contiguous");
        optionalBoolean(args, "sampleAllLayers");
        const sampleSize = optionalString(args, "sampleSize") ?? "Point Sample";
        if (!WAND_SAMPLE_SIZES.includes(sampleSize)) {
          throw new CompositorMcpError("invalid_arguments", "sampleSize must be Point Sample, 3 by 3 Average or 5 by 5 Average.");
        }
        const mode = selectionMode(args);
        // Approximation: mock pixel layers are a uniform colour, so a matching seed
        // floods a tolerance-scaled patch centred on the point (clipped to the canvas).
        // A document without a pixel layer has nothing to sample, so nothing matches —
        // upstream then deselects in replace mode and leaves the selection otherwise.
        if (document.layers.some((layer) => !layer.group)) {
          const half = Math.max(1, tolerance);
          this.combineSelection({ x: x - half, y: y - half, width: half * 2, height: half * 2 }, mode);
        } else if (mode === "replace") {
          document.selection = null;
        }
        this.revision += 1;
        return this.selectionValue();
      }
      case "pixels.fill": {
        const document = this.requireDocument();
        const layer = document.layers.find((candidate) => candidate.id === document.activeLayerId);
        if (!layer || layer.group) {
          throw new CompositorMcpError("pixel_edit_unavailable", "The active layer or mask cannot be filled.");
        }
        const target = optionalString(args, "target") ?? "foreground";
        if (target !== "foreground" && target !== "background") {
          throw new CompositorMcpError("invalid_arguments", "target must be foreground or background.");
        }
        // Fills the selection, or the whole layer when no selection exists.
        layer.fill = document.selection ? { ...document.selection } : { x: layer.transform.x, y: layer.transform.y, width: layer.transform.width, height: layer.transform.height };
        this.revision += 1;
        return { filled: true, target };
      }
      case "paint.brushStroke":
      case "paint.spotHeal":
      case "paint.clone":
      case "paint.blur": {
        const { document, layer } = this.requirePaintTarget();
        const points = strokePoints(args);
        const diameter = boundedNumber(args, "diameter", 1, 2000, " pixels") ?? 40;
        const hardness = boundedNumber(args, "hardness", 0, 1) ?? 1;
        const strengthKey = operation.name === "paint.blur" ? "strength" : "opacity";
        const strength = boundedNumber(args, strengthKey, 0.01, 1) ?? 1;
        switch (operation.name) {
          case "paint.brushStroke": {
            const mode = optionalString(args, "mode") ?? "paint";
            if (mode !== "paint" && mode !== "erase") {
              throw new CompositorMcpError("invalid_arguments", "mode must be paint or erase.");
            }
            optionalHexColor(args, "color");
            break;
          }
          case "paint.spotHeal": {
            const mode = optionalString(args, "mode") ?? "Content-Aware";
            if (!SPOT_HEAL_MODES.includes(mode)) {
              throw new CompositorMcpError("invalid_arguments", "mode must be Content-Aware, Create Texture or Proximity Match.");
            }
            break;
          }
          case "paint.clone": {
            requiredPoint(args, "source");
            optionalBoolean(args, "aligned");
            optionalBoolean(args, "sampleAllLayers");
            break;
          }
          default: {
            const mode = optionalString(args, "mode") ?? "Blur";
            if (!BLUR_MODES.includes(mode)) {
              throw new CompositorMcpError("invalid_arguments", "mode must be Blur, Smudge or Liquify.");
            }
            break;
          }
        }
        // Approximation: coverage is the point bounds grown by the brush radius, clipped
        // to the canvas and the active selection — the mock stores no pixels.
        const bounds = strokeBounds(points, diameter / 2, document);
        if (!bounds) {
          return { applied: false, layerId: layer.id, mask: false, points: points.length, bounds: null };
        }
        layer.fill = bounds;
        this.revision += 1;
        return { applied: true, layerId: layer.id, mask: false, points: points.length, bounds: boundsJson(bounds) };
      }
      case "paint.gradient": {
        const { document, layer } = this.requirePaintTarget();
        const start = requiredPoint(args, "start");
        const end = requiredPoint(args, "end");
        const shape = optionalString(args, "shape") ?? "Linear";
        if (!GRADIENT_SHAPES.includes(shape)) {
          throw new CompositorMcpError("invalid_arguments", "shape must be Linear or Radial.");
        }
        const style = optionalString(args, "style") ?? "Foreground to Transparent";
        if (!GRADIENT_STYLES.includes(style)) {
          throw new CompositorMcpError("invalid_arguments", "style must be Foreground to Background or Foreground to Transparent.");
        }
        const opacity = boundedNumber(args, "opacity", 0, 1) ?? 1;
        optionalBoolean(args, "reversed");
        const stops = args["stops"];
        if (stops !== undefined && stops !== null) {
          if (!Array.isArray(stops) || stops.length < 2 || stops.length > 32) {
            throw new CompositorMcpError("invalid_arguments", "stops must be an array of 2 to 32 colour stops.");
          }
          for (const stop of stops) {
            if (!isJsonObject(stop)) {
              throw new CompositorMcpError("invalid_arguments", "stops must contain {offset, color} entries.");
            }
            const { offset, color } = stop;
            if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0 || offset > 1 || typeof color !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(color)) {
              throw new CompositorMcpError("invalid_arguments", "stops must contain {offset, color} entries with offset between 0 and 1.");
            }
          }
        }
        // A sub-half-pixel line is the click the gradient tool discards.
        if (Math.hypot(end.x - start.x, end.y - start.y) < 0.5 || opacity <= 0) {
          return { applied: false, layerId: layer.id, mask: false, points: 0, bounds: null };
        }
        const bounds: MockSelection = document.selection
          ? { ...document.selection }
          : { x: 0, y: 0, width: document.width, height: document.height };
        layer.fill = bounds;
        this.revision += 1;
        return { applied: true, layerId: layer.id, mask: false, points: 0, bounds: boundsJson(bounds) };
      }
      case "paint.shape": {
        const document = this.requireDocument();
        const kind = optionalString(args, "kind") ?? "Rectangle";
        if (!SHAPE_KINDS.includes(kind)) {
          throw new CompositorMcpError("invalid_arguments", "kind must be Rectangle or Ellipse.");
        }
        const x = requiredNumber(args, "x");
        const y = requiredNumber(args, "y");
        const width = requiredNumber(args, "width");
        const height = requiredNumber(args, "height");
        checkBounds(Math.round(width), "width and height", 1, 30_000, " pixels");
        checkBounds(Math.round(height), "width and height", 1, 30_000, " pixels");
        const cornerRadius = boundedNumber(args, "cornerRadius", 0, 15_000, " pixels") ?? 0;
        if (Math.round(width) * Math.round(height) > 100_000_000) {
          throw new CompositorMcpError("invalid_arguments", "That shape is too large. A shape can cover up to 100 megapixels.");
        }
        optionalHexColor(args, "color");
        let name = optionalString(args, "name");
        if (!name) {
          // nextShapeName: "Rectangle 1", "Ellipse 2", … skipping names already present.
          const names = new Set(document.layers.map((layer) => layer.name));
          let number = 1;
          while (names.has(`${kind} ${number}`)) number += 1;
          name = `${kind} ${number}`;
        }
        const active = document.layers.find((candidate) => candidate.id === document.activeLayerId);
        const layer = mockLayer(document, {
          name,
          parentId: active?.group === true ? active.id : active?.parentId ?? null,
          transform: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height), rotation: 0, flipX: false, flipY: false, sampling: "High quality" },
          shape: true,
        });
        const index = active ? document.layers.indexOf(active) + 1 : document.layers.length;
        document.layers.splice(index, 0, layer);
        document.activeLayerId = layer.id;
        document.selectedLayerIds = [layer.id];
        this.revision += 1;
        return layer as unknown as JsonValue;
      }
      case "adjustment.add": {
        const document = this.requireDocument();
        const kind = requiredString(args, "kind");
        if (!ADJUSTMENT_KINDS.includes(kind)) {
          throw new CompositorMcpError("invalid_arguments", `Unknown adjustment kind: ${kind}`);
        }
        const parameters = optionalObject(args, "parameters");
        const active = document.layers.find((candidate) => candidate.id === document.activeLayerId);
        // Mirrors addAdjustment: inserts above the active layer, adopts its parent, and
        // becomes the active layer; the layer name defaults to the kind.
        const layer = mockLayer(document, {
          name: optionalString(args, "name") ?? kind,
          parentId: active?.group === true ? active.id : active?.parentId ?? null,
          adjustment: true,
          adjustmentKind: kind,
          adjustmentParameters: parameters ?? {},
        });
        const index = active ? document.layers.indexOf(active) + 1 : document.layers.length;
        document.layers.splice(index, 0, layer);
        document.activeLayerId = layer.id;
        document.selectedLayerIds = [layer.id];
        this.revision += 1;
        return layer as unknown as JsonValue;
      }
      case "adjustment.update": {
        const layer = this.requireLayer(this.resolveLayerId(requiredString(args, "layerId")));
        const kind = requiredString(args, "kind");
        if (!ADJUSTMENT_KINDS.includes(kind)) {
          throw new CompositorMcpError("invalid_arguments", `Unknown adjustment kind: ${kind}`);
        }
        if (!layer.adjustment) {
          throw new CompositorMcpError("invalid_arguments", "The layer is not an adjustment layer.");
        }
        if (layer.adjustmentKind !== kind) {
          throw new CompositorMcpError("invalid_arguments", `kind must match the layer's adjustment kind (${layer.adjustmentKind}).`);
        }
        const parameters = optionalObject(args, "parameters");
        if (parameters === undefined) {
          throw new CompositorMcpError("invalid_arguments", "parameters is required and must be an object.");
        }
        layer.adjustmentParameters = { ...layer.adjustmentParameters, ...parameters };
        this.revision += 1;
        return layer as unknown as JsonValue;
      }
      case "filter.apply": {
        const document = this.requireDocument();
        const kind = requiredString(args, "kind");
        if (!FILTER_KINDS.includes(kind)) {
          throw new CompositorMcpError("invalid_arguments", `Unknown filter kind: ${kind}`);
        }
        const settings = optionalObject(args, "settings");
        const layer = this.filterTarget(document, kind);
        if (kind === "Remove Background") {
          // commitBackgroundMask semantics: the subject is kept via a new mask.
          layer.mask = true;
        } else {
          // FilterEdit.blurMargin: the committed render can grow the layer — Gaussian by
          // ceil(radius * 3 + 2), Motion Blur by ceil(distance / 2 + 2) document pixels.
          const margin = kind === "Gaussian Blur"
            ? Math.ceil((typeof settings?.["radius"] === "number" ? settings["radius"] : 1) * 3 + 2)
            : kind === "Motion Blur"
              ? Math.ceil((typeof settings?.["distance"] === "number" ? settings["distance"] : 10) / 2 + 2)
              : 0;
          layer.transform.x -= margin;
          layer.transform.y -= margin;
          layer.transform.width += margin * 2;
          layer.transform.height += margin * 2;
          layer.fill = document.selection
            ? { ...document.selection }
            : { x: layer.transform.x, y: layer.transform.y, width: layer.transform.width, height: layer.transform.height };
        }
        this.revision += 1;
        return { applied: true, kind, layerId: layer.id, mask: layer.mask };
      }
      case "pixels.contentAwareFill": {
        const document = this.requireDocument();
        const layer = this.filterTarget(document, "Content-Aware Fill");
        // Upstream CAF grows the layer so the fill can extend past its old edge.
        const selection = document.selection!;
        const left = Math.min(layer.transform.x, selection.x);
        const top = Math.min(layer.transform.y, selection.y);
        const right = Math.max(layer.transform.x + layer.transform.width, selection.x + selection.width);
        const bottom = Math.max(layer.transform.y + layer.transform.height, selection.y + selection.height);
        layer.transform.x = left;
        layer.transform.y = top;
        layer.transform.width = right - left;
        layer.transform.height = bottom - top;
        layer.fill = { ...selection };
        this.revision += 1;
        return { applied: true, kind: "Content-Aware Fill", layerId: layer.id, mask: layer.mask };
      }
      case "preview.render": {
        const document = this.requireDocument();
        // Same convention the bridge uses: a full-resolution PNG under
        // <tmp>/Compositor-MCP/preview-<uuid>.png, returning path + dimensions.
        await fs.mkdir(PREVIEW_DIRECTORY, { recursive: true, mode: 0o700 });
        const destination = path.join(PREVIEW_DIRECTORY, `preview-${randomUUID()}.png`);
        await fs.writeFile(destination, this.previewImage, { mode: 0o600 });
        return { path: destination, width: document.width, height: document.height, mediaType: "image/png" };
      }
      case "history.undo":
      case "history.redo":
        return { supportedInMock: false };
      default:
        throw new CompositorMcpError("mock_unsupported", `The mock bridge does not implement ${operation.name}.`);
    }
  }

  /// The selection snapshot the real bridge returns for selection operations:
  /// `{ exists, antialiased, bounds }`, or null when nothing is selected.
  private selectionValue(): JsonValue {
    const selection = this.document?.selection;
    if (!selection) return null;
    return { exists: true, antialiased: true, bounds: { ...selection } };
  }

  /// Mirrors upstream `finishLasso` + `applySelection`: the shape is clipped to the
  /// canvas and combined by mode. An outline whose clipped area is empty selects
  /// nothing — in replace mode it deselects. Subtract uses a bounding-box
  /// approximation: a clip covering the current bounds empties the selection.
  private combineSelection(shape: MockSelection, mode: string): void {
    const document = this.requireDocument();
    if (shape.width <= 0 || shape.height <= 0) {
      if (mode === "replace") document.selection = null;
      return;
    }
    const left = Math.max(0, shape.x);
    const top = Math.max(0, shape.y);
    const right = Math.min(document.width, shape.x + shape.width);
    const bottom = Math.min(document.height, shape.y + shape.height);
    if (right <= left || bottom <= top) {
      if (mode === "replace") document.selection = null;
      return;
    }
    const clipped: MockSelection = { x: left, y: top, width: right - left, height: bottom - top };
    switch (mode) {
      case "replace":
        document.selection = clipped;
        break;
      case "add": {
        const current = document.selection;
        if (!current) {
          document.selection = clipped;
          break;
        }
        const ux = Math.min(current.x, clipped.x);
        const uy = Math.min(current.y, clipped.y);
        document.selection = {
          x: ux,
          y: uy,
          width: Math.max(current.x + current.width, clipped.x + clipped.width) - ux,
          height: Math.max(current.y + current.height, clipped.y + clipped.height) - uy,
        };
        break;
      }
      case "subtract": {
        const current = document.selection;
        if (!current) return;
        const covers = clipped.x <= current.x && clipped.y <= current.y
          && clipped.x + clipped.width >= current.x + current.width
          && clipped.y + clipped.height >= current.y + current.height;
        if (covers) document.selection = null;
        break;
      }
    }
  }

  private requireDocument(): MockDocument {
    if (!this.document) throw new CompositorMcpError("document_required", "Create or open a document first.");
    return this.document;
  }

  private resolveLayerId(id: string): string {
    if (id !== "active") return id;
    const active = this.requireDocument().activeLayerId;
    if (!active) throw new CompositorMcpError("layer_required", "No active layer exists.");
    return active;
  }

  private requireLayer(id: string): MockLayer {
    const layer = this.requireDocument().layers.find((candidate) => candidate.id === id);
    if (!layer) throw new CompositorMcpError("layer_not_found", `Layer not found: ${id}`);
    return layer;
  }

  /// The document plus the single selected pixel layer a stroke or gradient
  /// lands on — the paint-target gate shared by the paint.* operations.
  private requirePaintTarget(): { document: MockDocument; layer: MockLayer } {
    const document = this.requireDocument();
    const layer = document.layers.find((candidate) => candidate.id === document.activeLayerId);
    if (!layer || document.selectedLayerIds.length !== 1) {
      throw new CompositorMcpError("layer_required", "Select exactly one layer to paint on.");
    }
    if (layer.group) {
      throw new CompositorMcpError("pixel_edit_unavailable", "The active layer or mask cannot be painted.");
    }
    return { document, layer };
  }

  /// The layer a filter lands on, mirroring the bridge's requireFilterTarget: one selected
  /// pixel layer (groups refused) and, for Content-Aware Fill, a live selection.
  private filterTarget(document: MockDocument, kind: string): MockLayer {
    const layer = document.layers.find((candidate) => candidate.id === document.activeLayerId);
    if (!layer || document.selectedLayerIds.length !== 1) {
      throw new CompositorMcpError("layer_required", "Select exactly one layer to filter.");
    }
    if (layer.group) {
      throw new CompositorMcpError("invalid_arguments", "Filters apply to a pixel layer, not a group.");
    }
    if (kind === "Content-Aware Fill" && !document.selection) {
      throw new CompositorMcpError("selection_required", "Content-Aware Fill needs a non-empty selection.");
    }
    return layer;
  }
}

/// A fresh layer record with the defaults every insertion path shares —
/// callers override the fields their operation sets (name, parent, flags,
/// transform). The frame defaults to the full canvas.
function mockLayer(document: MockDocument, overrides: Partial<MockLayer> = {}): MockLayer {
  return {
    id: randomUUID(),
    name: "Layer",
    visible: true,
    opacity: 1,
    blendMode: "Normal",
    parentId: null,
    group: false,
    transform: { x: 0, y: 0, width: document.width, height: document.height, rotation: 0, flipX: false, flipY: false, sampling: "High quality" },
    mask: false,
    shape: false,
    adjustment: false,
    adjustmentKind: null,
    adjustmentParameters: null,
    fill: null,
    ...overrides,
  };
}

function requiredString(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) throw new CompositorMcpError("invalid_arguments", `${key} must be a non-empty string.`);
  return value;
}

function optionalString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new CompositorMcpError("invalid_arguments", `${key} must be a string.`);
  return value;
}

function requiredNumber(object: JsonObject, key: string): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new CompositorMcpError("invalid_arguments", `${key} must be a finite number.`);
  return value;
}

const formatBound = (value: number): string => value.toLocaleString("en-US");

/// "<label> must be between <min> and <max><unit>." — the shared range error
/// behind the geometry and paint argument guards.
function checkBounds(value: number, label: string, minimum: number, maximum: number, unit = ""): void {
  if (value < minimum || value > maximum) {
    throw new CompositorMcpError("invalid_arguments", `${label} must be between ${formatBound(minimum)} and ${formatBound(maximum)}${unit}.`);
  }
}

/// Optional numeric argument plus a range check; an absent key passes undefined
/// through for the caller's default.
function boundedNumber(object: JsonObject, key: string, minimum: number, maximum: number, unit = ""): number | undefined {
  const value = optionalNumber(object, key);
  if (value !== undefined) checkBounds(value, key, minimum, maximum, unit);
  return value;
}

function optionalNumber(object: JsonObject, key: string): number | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new CompositorMcpError("invalid_arguments", `${key} must be a finite number.`);
  return value;
}

function requiredBoolean(object: JsonObject, key: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean") throw new CompositorMcpError("invalid_arguments", `${key} must be a boolean.`);
  return value;
}

function requiredStringArray(object: JsonObject, key: string): string[] {
  const value = object[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new CompositorMcpError("invalid_arguments", `${key} must be an array of strings.`);
  }
  return value as string[];
}

function optionalBoolean(object: JsonObject, key: string): boolean | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new CompositorMcpError("invalid_arguments", `${key} must be a boolean.`);
  return value;
}

function optionalObject(object: JsonObject, key: string): JsonObject | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (!isJsonObject(value)) {
    throw new CompositorMcpError("invalid_arguments", `${key} must be an object.`);
  }
  return value;
}

interface Point {
  x: number;
  y: number;
}

function requiredPoint(object: JsonObject, key: string): Point {
  const value = object[key];
  if (!isJsonObject(value)) {
    throw new CompositorMcpError("invalid_arguments", `${key} must be an {x, y} point.`);
  }
  const { x, y } = value;
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
    throw new CompositorMcpError("invalid_arguments", `${key} must be an {x, y} point.`);
  }
  return { x, y };
}

/// Stroke paths are bounded like the catalogue schema (1–100,000 points).
function strokePoints(object: JsonObject): Point[] {
  const points = requiredPoints(object, "points");
  if (points.length < 1 || points.length > 100_000) {
    throw new CompositorMcpError("invalid_arguments", "points must be an array of 1 to 100,000 {x, y} points.");
  }
  return points;
}

function optionalHexColor(object: JsonObject, key: string): void {
  const value = optionalString(object, key);
  if (value !== undefined && !/^#[0-9A-Fa-f]{6}$/.test(value)) {
    throw new CompositorMcpError("invalid_arguments", `${key} must be a six-digit hex colour.`);
  }
}

/// Bounding box of a point list in one pass — a Math.min(...points) spread over
/// a schema-legal 100,000-point stroke would overflow the argument limit.
function pointsBounds(points: Point[]): { left: number; top: number; right: number; bottom: number } {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const point of points) {
    if (point.x < left) left = point.x;
    if (point.y < top) top = point.y;
    if (point.x > right) right = point.x;
    if (point.y > bottom) bottom = point.y;
  }
  return { left, top, right, bottom };
}

/// Approximate painted coverage: the point bounds grown by the brush radius, clipped to
/// the canvas, then to the active selection like the real stroke's selection clip.
/// Null when nothing would land — the no-op stroke outcome.
function strokeBounds(points: Point[], radius: number, document: MockDocument): MockSelection | null {
  const bounds = pointsBounds(points);
  let left = Math.max(0, bounds.left - radius);
  let top = Math.max(0, bounds.top - radius);
  let right = Math.min(document.width, bounds.right + radius);
  let bottom = Math.min(document.height, bounds.bottom + radius);
  if (document.selection) {
    const selection = document.selection;
    const selRight = selection.x + selection.width;
    const selBottom = selection.y + selection.height;
    left = Math.max(left, selection.x);
    top = Math.max(top, selection.y);
    right = Math.min(right, selRight);
    bottom = Math.min(bottom, selBottom);
  }
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/// A fresh literal: JsonValue needs an implicit index signature, which interface-typed
/// values don't carry.
function boundsJson(bounds: MockSelection): JsonObject {
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

function requiredPoints(object: JsonObject, key: string): Point[] {
  const value = object[key];
  if (!Array.isArray(value)) {
    throw new CompositorMcpError("invalid_arguments", `${key} must be an array of {x, y} points.`);
  }
  return value.map((item) => {
    if (!isJsonObject(item)) {
      throw new CompositorMcpError("invalid_arguments", `${key} must contain {x, y} points.`);
    }
    const { x, y } = item;
    if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
      throw new CompositorMcpError("invalid_arguments", `${key} must contain {x, y} points.`);
    }
    return { x, y };
  });
}

function requiredCorners(object: JsonObject, key: string): Point[] {
  const value = object[key];
  if (!Array.isArray(value) || value.length !== 4) {
    throw new CompositorMcpError("invalid_arguments", `${key} must be an array of four points.`);
  }
  return requiredPoints(object, key);
}

/// Same convex, non-degenerate quadrilateral check as upstream `DistortWarp.isUsable`.
function isUsableDistortCorners(corners: Point[]): boolean {
  if (corners.some((corner) => Math.abs(corner.x) > 1_000_000 || Math.abs(corner.y) > 1_000_000)) return false;
  let sign = 0;
  for (let index = 0; index < 4; index += 1) {
    const a = corners[index]!;
    const b = corners[(index + 1) % 4]!;
    const c = corners[(index + 2) % 4]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) <= 0.01) return false;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

const CANVAS_ANCHORS = ["top-left", "top", "top-right", "left", "centre", "right", "bottom-left", "bottom", "bottom-right"];

const WAND_SAMPLE_SIZES = ["Point Sample", "3 by 3 Average", "5 by 5 Average"];

const SPOT_HEAL_MODES = ["Content-Aware", "Create Texture", "Proximity Match"];
const BLUR_MODES = ["Blur", "Smudge", "Liquify"];
const GRADIENT_SHAPES = ["Linear", "Radial"];
const GRADIENT_STYLES = ["Foreground to Background", "Foreground to Transparent"];
const SHAPE_KINDS = ["Rectangle", "Ellipse"];

/// Upstream AdjustmentKind and FilterKind raw values, as the catalogue's oneOf branches list them.
const ADJUSTMENT_KINDS = ["Hue/Saturation", "Levels", "Curves", "Exposure", "Gradient Map", "Grain"];
const FILTER_KINDS = [
  "Gaussian Blur", "Motion Blur", "Add Noise", "Lens Correction", "Remove Background",
  "Content-Aware Fill", "Curves", "Exposure", "Gradient Map", "Grain",
];

function selectionMode(object: JsonObject): string {
  const mode = optionalString(object, "mode") ?? "replace";
  if (mode !== "replace" && mode !== "add" && mode !== "subtract") {
    throw new CompositorMcpError("invalid_arguments", "mode must be replace, add or subtract.");
  }
  return mode;
}

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));
