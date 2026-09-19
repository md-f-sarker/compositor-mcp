#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { BridgeTransport } from "./bridge-client.js";
import { SocketBridgeTransport } from "./bridge-client.js";
import { MockBridgeTransport } from "./mock-bridge.js";
import { createCompositorMcpServer } from "./server.js";

function createBridge(): BridgeTransport {
  return process.env.COMPOSITOR_MCP_MOCK === "1"
    ? new MockBridgeTransport()
    : new SocketBridgeTransport();
}

await serveStdio(() => createCompositorMcpServer(createBridge()));
