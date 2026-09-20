import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ProtocolError,
  ProtocolErrorCode,
  type ImageContent,
  type McpServer,
  type ReadResourceResult,
} from "@modelcontextprotocol/server";
import { CAPABILITIES, isJsonObject, type JsonObject, type JsonValue } from "@compositor-mcp/protocol";
import type { BridgeTransport } from "./bridge-client.js";
import { CompositorMcpError } from "./errors.js";

export const STATE_RESOURCE_URI = "compositor://state";
export const LAYERS_RESOURCE_URI = "compositor://layers";
export const CAPABILITIES_RESOURCE_URI = "compositor://capabilities";
export const PREVIEW_RESOURCE_URI = "compositor://preview/latest";

/** PNGs at or under this size are inlined into the execute result; larger renders stay path-only. */
export const INLINE_PREVIEW_MAX_BYTES = 1024 * 1024;
/** Absolute guard rail so a bad preview path can never swap a huge file into the process. */
const PREVIEW_READ_MAX_BYTES = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/// The preview convention the bridge and the mock both write into:
/// <tmp>/Compositor-MCP/preview-<uuid>.png with owner-only permissions.
export const PREVIEW_DIRECTORY = path.join(os.tmpdir(), "Compositor-MCP");
const PREVIEW_NAME_PATTERN = /^preview-.+\.png$/;

export function isPreviewPath(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return path.dirname(resolved) === PREVIEW_DIRECTORY && PREVIEW_NAME_PATTERN.test(path.basename(resolved));
}

export interface LatestPreview {
  path: string;
  width: number | null;
  height: number | null;
  bytes: Buffer;
  renderedAt: string;
}

/// Per-server cache for the most recent preview.render PNG, serving
/// compositor://preview/latest. Populated by captureLatestPreview after each
/// successful execute; empty caches answer with a plain-text placeholder.
export class PreviewCache {
  latest: LatestPreview | undefined = undefined;
}

export function registerCompositorResources(server: McpServer, transport: BridgeTransport, previews: PreviewCache): void {
  server.registerResource(
    "state",
    STATE_RESOURCE_URI,
    {
      title: "Compositor editor state",
      description:
        "JSON snapshot of open projects, the current document, layer stack, selection and revision — the same payload the app.getState operation returns.",
      mimeType: "application/json",
    },
    async (uri) => jsonContents(uri.href, await bridgeRequest(transport, "state")),
  );

  server.registerResource(
    "layers",
    LAYERS_RESOURCE_URI,
    {
      title: "Current layer tree",
      description: "The current document's layer stack (ids, names, groups, masks, transforms) flattened out of the state snapshot.",
      mimeType: "application/json",
    },
    async (uri) => jsonContents(uri.href, layerTree(await bridgeRequest(transport, "state"))),
  );

  server.registerResource(
    "capabilities",
    CAPABILITIES_RESOURCE_URI,
    {
      title: "Capability catalogue",
      description: "The full operation catalogue the connected Compositor build implements — names, risk classes, status and JSON schemas.",
      mimeType: "application/json",
    },
    async (uri) => jsonContents(uri.href, withCatalogue(await bridgeRequest(transport, "capabilities"))),
  );

  server.registerResource(
    "preview-latest",
    PREVIEW_RESOURCE_URI,
    {
      title: "Latest preview render",
      description:
        "PNG bytes of the most recent preview.render result this server session produced. Reads as text/plain guidance until the first render runs.",
      mimeType: "image/png",
    },
    async (uri) => {
      const latest = previews.latest;
      if (!latest) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: "No preview has been rendered yet in this session. Run the preview.render operation through the execute tool; the PNG is then served here and inlined into the tool result when small enough.",
            },
          ],
        };
      }
      return {
        contents: [{ uri: uri.href, mimeType: "image/png", blob: latest.bytes.toString("base64") }],
      };
    },
  );
}

/// Scans a finished execute envelope for the last successful preview.render
/// operation, caches its PNG for compositor://preview/latest, and returns the
/// inline image content block to append to the tool result — empty when no
/// render ran, the file is unreadable, or the PNG exceeds INLINE_PREVIEW_MAX_BYTES.
export async function captureLatestPreview(result: JsonValue, previews: PreviewCache): Promise<ImageContent[]> {
  const render = lastPreviewRender(result);
  if (!render) return [];
  const bytes = await readPreviewPng(render.path);
  if (!bytes) return [];
  previews.latest = { ...render, bytes, renderedAt: new Date().toISOString() };
  if (bytes.length > INLINE_PREVIEW_MAX_BYTES) return [];
  return [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }];
}

/// Reads a preview PNG after pinning it to the preview-path convention —
/// anything else the bridge names would hand a compromised app an
/// arbitrary-file oracle. The open-first ordering makes the size guard safe:
/// fstat runs on the opened fd, so a swapped path can never race the read.
async function readPreviewPng(previewPath: string): Promise<Buffer | null> {
  if (!isPreviewPath(previewPath)) return null;
  let handle: fs.FileHandle | undefined;
  try {
    // O_NOFOLLOW refuses a symlink swapped in at the preview path — the fstat
    // below then always describes the real preview file, never a linked target.
    handle = await fs.open(previewPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > PREVIEW_READ_MAX_BYTES) return null;
    const bytes = await handle.readFile();
    // fstat bounds the size at open time; a same-inode append could still slip
    // past it, so the bytes themselves are checked before being trusted.
    if (bytes.length > PREVIEW_READ_MAX_BYTES) return null;
    return bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ? bytes : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function lastPreviewRender(result: JsonValue): { path: string; width: number | null; height: number | null } | null {
  const root = asObject(result);
  const results = root?.["results"];
  if (!Array.isArray(results)) return null;
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const entry = asObject(results[index]);
    if (!entry || entry["name"] !== "preview.render" || entry["ok"] !== true) continue;
    const value = asObject(entry["value"]);
    const previewPath = value?.["path"];
    if (!value || typeof previewPath !== "string") continue;
    const width = value["width"];
    const height = value["height"];
    return {
      path: previewPath,
      width: typeof width === "number" ? width : null,
      height: typeof height === "number" ? height : null,
    };
  }
  return null;
}

/// The bridge's capabilities payload only names the implemented operations
/// ({ protocol, implemented, revision }) — the documented catalogue (names,
/// titles, risk classes, status, JSON schemas) is the same shared registry the
/// search tool serves, so it is synthesised here and filtered to the names the
/// connected build actually reports. A payload without an `implemented` list
/// falls back to the registry's implemented entries.
function withCatalogue(payload: JsonValue): JsonValue {
  const root = asObject(payload);
  if (!root) return payload;
  const reported = root["implemented"];
  const implemented = Array.isArray(reported)
    ? new Set(reported.filter((name): name is string => typeof name === "string"))
    : new Set(CAPABILITIES.filter((capability) => capability.status === "implemented").map((capability) => capability.name));
  return {
    ...root,
    catalogue: CAPABILITIES.filter((capability) => implemented.has(capability.name)) as unknown as JsonValue,
  };
}

/// The open document rides under `document` on both the real bridge and the
/// mock; `current` is still tolerated for older mock snapshots. Both are
/// flattened to { revision, documentId, layers }.
function layerTree(state: JsonValue): JsonValue {
  const root = asObject(state);
  const document = asObject(root?.["document"]) ?? asObject(root?.["current"]);
  const layers = document && Array.isArray(document["layers"]) ? document["layers"] : [];
  return {
    revision: typeof root?.["revision"] === "number" ? root["revision"] : null,
    documentId: document && typeof document["id"] === "string" ? document["id"] : null,
    layers,
  };
}

async function bridgeRequest(transport: BridgeTransport, method: "state" | "capabilities"): Promise<JsonValue> {
  try {
    return await transport.request(method);
  } catch (error) {
    throw asProtocolError(error);
  }
}

/// Resource reads cannot return an isError result the way tools can, so bridge
/// failures surface as protocol errors whose data carries the same
/// { code, message, retryable } shape a failed execute returns.
function asProtocolError(error: unknown): Error {
  if (error instanceof CompositorMcpError) {
    return new ProtocolError(ProtocolErrorCode.InternalError, error.message, error.toJSON());
  }
  return error instanceof Error ? error : new Error(String(error));
}

function jsonContents(uri: string, value: JsonValue): ReadResourceResult {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }] };
}

function asObject(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}
