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

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));
