import { randomUUID } from "node:crypto";
import type {
  BridgeRequest,
  ExecuteRequest,
  JsonObject,
  JsonValue,
  Operation,
  OperationResult,
} from "@compositor-mcp/protocol";
import { CAPABILITIES } from "@compositor-mcp/protocol";
import { CompositorMcpError } from "./errors.js";
import type { BridgeTransport } from "./bridge-client.js";

interface MockLayer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blendMode: string;
  parentId: string | null;
  group: boolean;
  transform: { x: number; y: number; width: number; height: number; rotation: number; flipX: boolean; flipY: boolean; sampling: string };
  mask: boolean;
}

interface MockDocument {
  id: string;
  width: number;
  height: number;
  resolution: number;
  layers: MockLayer[];
  activeLayerId: string | null;
  selectedLayerIds: string[];
  hasSelection: boolean;
}

export class MockBridgeTransport implements BridgeTransport {
  private revision = 0;
  private document: MockDocument | null = null;

  async request(method: BridgeRequest["method"], params?: JsonObject): Promise<JsonValue> {
    switch (method) {
      case "ping":
        return { ok: true, mock: true, revision: this.revision };
      case "capabilities":
        return CAPABILITIES as unknown as JsonValue;
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

  private execute(request: ExecuteRequest): JsonValue {
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
        const value = this.apply(operation);
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
      revision: this.revision,
      results,
      state: this.state(),
    } as unknown as JsonValue;
  }

  private apply(operation: Operation): JsonValue {
    const args = operation.arguments ?? {};
    switch (operation.name) {
      case "app.ping":
        return { ok: true, mock: true };
      case "app.getState":
      case "workspace.list":
      case "layer.list":
      case "selection.get":
        return this.state();
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
          hasSelection: false,
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
        if (Math.round(width) < 1 || Math.round(width) > 30_000 || Math.round(height) < 1 || Math.round(height) > 30_000) {
          throw new CompositorMcpError("invalid_arguments", "Document dimensions must be between 1 and 30,000 pixels.");
        }
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
        if (Math.round(width) < 1 || Math.round(width) > 30_000 || Math.round(height) < 1 || Math.round(height) > 30_000) {
          throw new CompositorMcpError("invalid_arguments", "Document dimensions must be between 1 and 30,000 pixels.");
        }
        if (Math.round(width) * Math.round(height) > 100_000_000) {
          throw new CompositorMcpError("invalid_arguments", "This project exceeds the supported canvas, layer, file-size, or 100-megapixel image limit.");
        }
        const resolution = optionalNumber(args, "resolution");
        if (resolution !== undefined && (resolution < 1 || resolution > 2400)) {
          throw new CompositorMcpError("invalid_arguments", "resolution must be between 1 and 2,400 DPI.");
        }
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
        const id = randomUUID();
        const layer: MockLayer = {
          id,
          name: optionalString(args, "name") ?? `Layer ${document.layers.length + 1}`,
          visible: true,
          opacity: 1,
          blendMode: "Normal",
          parentId: null,
          group: false,
          transform: { x: 0, y: 0, width: document.width, height: document.height, rotation: 0, flipX: false, flipY: false, sampling: "High quality" },
          mask: false,
        };
        document.layers.push(layer);
        document.activeLayerId = id;
        document.selectedLayerIds = [id];
        this.revision += 1;
        return layer as unknown as JsonValue;
      }
      case "layer.group": {
        const document = this.requireDocument();
        const selected = new Set(document.selectedLayerIds);
        if (selected.size === 0) throw new CompositorMcpError("layer_required", "Select at least one layer first.");
        const id = randomUUID();
        let topIndex = -1;
        document.layers.forEach((layer, index) => {
          if (selected.has(layer.id)) topIndex = index;
        });
        const group: MockLayer = {
          id,
          name: optionalString(args, "name") ?? "Folder 1",
          visible: true,
          opacity: 1,
          blendMode: "Normal",
          parentId: document.layers[topIndex]?.parentId ?? null,
          group: true,
          transform: { x: 0, y: 0, width: document.width, height: document.height, rotation: 0, flipX: false, flipY: false, sampling: "High quality" },
          mask: false,
        };
        document.layers.splice(topIndex + 1, 0, group);
        for (const layer of document.layers) {
          if (selected.has(layer.id)) layer.parentId = id;
        }
        document.activeLayerId = id;
        document.selectedLayerIds = [id];
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
        const xs = corners.map((corner) => corner.x);
        const ys = corners.map((corner) => corner.y);
        const left = Math.floor(Math.min(...xs));
        const top = Math.floor(Math.min(...ys));
        layer.transform.x = left;
        layer.transform.y = top;
        layer.transform.width = Math.ceil(Math.max(...xs)) - left;
        layer.transform.height = Math.ceil(Math.max(...ys)) - top;
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
        if (mode === "from-selection" && !this.requireDocument().hasSelection) {
          throw new CompositorMcpError("selection_required", "from-selection requires an active selection.");
        }
        layer.mask = true;
        this.revision += 1;
        return layer as unknown as JsonValue;
      }
      case "layer.featherMask": {
        const layer = this.requireLayer(this.resolveLayerId(requiredString(args, "layerId")));
        const radius = requiredNumber(args, "radius");
        if (radius < 0 || radius > 10_000) {
          throw new CompositorMcpError("invalid_arguments", "radius must be between 0 and 10,000 pixels.");
        }
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
        const document = this.requireDocument();
        const id = this.resolveLayerId(requiredString(args, "layerId"));
        const index = document.layers.findIndex((layer) => layer.id === id);
        if (index < 0) throw new CompositorMcpError("layer_not_found", `Layer not found: ${id}`);
        document.layers.splice(index, 1);
        document.activeLayerId = document.layers.length > 0 ? document.layers[document.layers.length - 1]?.id ?? null : null;
        document.selectedLayerIds = document.activeLayerId ? [document.activeLayerId] : [];
        this.revision += 1;
        return { deletedLayerId: id };
      }
      case "selection.all":
        this.requireDocument().hasSelection = true;
        this.revision += 1;
        return { selected: true };
      case "selection.none":
        this.requireDocument().hasSelection = false;
        this.revision += 1;
        return { selected: false };
      case "history.undo":
      case "history.redo":
        return { supportedInMock: false };
      default:
        throw new CompositorMcpError("mock_unsupported", `The mock bridge does not implement ${operation.name}.`);
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

interface Point {
  x: number;
  y: number;
}

function requiredCorners(object: JsonObject, key: string): Point[] {
  const value = object[key];
  if (!Array.isArray(value) || value.length !== 4) {
    throw new CompositorMcpError("invalid_arguments", `${key} must be an array of four points.`);
  }
  return value.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new CompositorMcpError("invalid_arguments", `${key} must contain {x, y} points.`);
    }
    const { x, y } = item as JsonObject;
    if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
      throw new CompositorMcpError("invalid_arguments", `${key} must contain {x, y} points.`);
    }
    return { x, y };
  });
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

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));
