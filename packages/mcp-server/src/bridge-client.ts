import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type {
  BridgeDiscovery,
  BridgeRequest,
  BridgeResponse,
  JsonObject,
  JsonValue,
} from "@compositor-mcp/protocol";
import { CompositorMcpError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface BridgeTransport {
  request(method: BridgeRequest["method"], params?: JsonObject): Promise<JsonValue>;
}

function defaultDiscoveryPath(): string {
  return path.join(os.homedir(), "Library", "Application Support", "Compositor", "MCP", "bridge.json");
}

function validateDiscovery(value: unknown): BridgeDiscovery {
  if (!value || typeof value !== "object") {
    throw new CompositorMcpError("invalid_bridge_discovery", "Bridge discovery file is not a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.protocol !== "compositor-bridge/1" ||
    typeof record.host !== "string" ||
    !isLoopbackHost(record.host) ||
    typeof record.port !== "number" ||
    !Number.isInteger(record.port) ||
    record.port < 1 ||
    record.port > 65535 ||
    typeof record.token !== "string" ||
    record.token.length < 32 ||
    typeof record.pid !== "number" ||
    !Number.isInteger(record.pid) ||
    record.pid < 1 ||
    typeof record.startedAt !== "string" ||
    !Number.isFinite(Date.parse(record.startedAt))
  ) {
    throw new CompositorMcpError("invalid_bridge_discovery", "Bridge discovery file has invalid fields.");
  }
  return record as unknown as BridgeDiscovery;
}


function isLoopbackHost(host: string): boolean {
  const normalised = host.trim().toLowerCase();
  return normalised === "localhost" || normalised === "::1" || normalised === "0:0:0:0:0:0:0:1" || normalised.startsWith("127.");
}

export class SocketBridgeTransport implements BridgeTransport {
  readonly discoveryPath: string;
  readonly timeoutMs: number;

  constructor(options: { discoveryPath?: string; timeoutMs?: number } = {}) {
    this.discoveryPath = options.discoveryPath ?? process.env.COMPOSITOR_MCP_BRIDGE_FILE ?? defaultDiscoveryPath();
    const configured = Number(process.env.COMPOSITOR_MCP_TIMEOUT_MS);
    this.timeoutMs = options.timeoutMs ?? (Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS);
  }

  async readDiscovery(): Promise<BridgeDiscovery> {
    let text: string;
    try {
      const metadata = await fs.stat(this.discoveryPath);
      if (!metadata.isFile()) {
        throw new CompositorMcpError("invalid_bridge_discovery", "Bridge discovery path is not a regular file.");
      }
      if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
        throw new CompositorMcpError("unsafe_bridge_discovery", "Bridge discovery file is owned by another user.");
      }
      if ((metadata.mode & 0o077) !== 0) {
        throw new CompositorMcpError("unsafe_bridge_discovery", "Bridge discovery file must not be accessible by group or other users.");
      }
      text = await fs.readFile(this.discoveryPath, "utf8");
    } catch (error) {
      if (error instanceof CompositorMcpError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new CompositorMcpError(
        "bridge_not_running",
        `Compositor bridge discovery file was not found at ${this.discoveryPath}. Start the MCP-enabled Compositor build first.`,
        { details: { cause: message }, retryable: true },
      );
    }

    try {
      return validateDiscovery(JSON.parse(text));
    } catch (error) {
      if (error instanceof CompositorMcpError) throw error;
      throw new CompositorMcpError("invalid_bridge_discovery", "Bridge discovery file contains invalid JSON.");
    }
  }

  async request(method: BridgeRequest["method"], params?: JsonObject): Promise<JsonValue> {
    const discovery = await this.readDiscovery();
    const request: BridgeRequest = {
      protocol: "compositor-bridge/1",
      id: randomUUID(),
      token: discovery.token,
      method,
      ...(params === undefined ? {} : { params }),
    };

    const response = await this.send(discovery, request);
    if (!response.ok) {
      const error = response.error ?? { code: "bridge_error", message: "Compositor returned an unknown error." };
      throw new CompositorMcpError(error.code, error.message, {
        ...(error.details === undefined ? {} : { details: error.details }),
        ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
      });
    }
    return response.result ?? null;
  }

  private send(discovery: BridgeDiscovery, request: BridgeRequest): Promise<BridgeResponse> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: discovery.host, port: discovery.port });
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        callback();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new CompositorMcpError("bridge_timeout", `Compositor did not respond within ${this.timeoutMs}ms.`, { retryable: true })));
      }, this.timeoutMs);

      socket.setNoDelay(true);
      socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`, "utf8"));
      socket.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          finish(() => reject(new CompositorMcpError("bridge_response_too_large", "Compositor bridge response exceeded 32 MiB.")));
          return;
        }
        chunks.push(chunk);
        const combined = Buffer.concat(chunks);
        const newline = combined.indexOf(0x0a);
        if (newline === -1) return;
        const line = combined.subarray(0, newline).toString("utf8");
        finish(() => {
          try {
            const parsed = JSON.parse(line) as BridgeResponse;
            if (parsed.protocol !== "compositor-bridge/1" || parsed.id !== request.id || typeof parsed.ok !== "boolean") {
              reject(new CompositorMcpError("invalid_bridge_response", "Compositor returned a malformed bridge response."));
              return;
            }
            resolve(parsed);
          } catch {
            reject(new CompositorMcpError("invalid_bridge_response", "Compositor returned invalid JSON."));
          }
        });
      });
      socket.on("error", (error) => {
        finish(() => reject(new CompositorMcpError("bridge_connection_failed", error.message, { retryable: true })));
      });
      socket.on("end", () => {
        if (!settled) finish(() => reject(new CompositorMcpError("bridge_closed", "Compositor closed the bridge connection without a response.", { retryable: true })));
      });
    });
  }
}
