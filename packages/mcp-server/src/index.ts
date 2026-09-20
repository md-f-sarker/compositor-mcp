#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { SocketBridgeTransport, type BridgeTransport } from "./bridge-client.js";
import { runCli } from "./cli.js";
import { MockBridgeTransport } from "./mock-bridge.js";
import { createCompositorMcpServer } from "./server.js";

function createBridge(): BridgeTransport {
  return process.env.COMPOSITOR_MCP_MOCK === "1"
    ? new MockBridgeTransport()
    : new SocketBridgeTransport();
}

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "serve") {
  await serveStdio(() => createCompositorMcpServer(createBridge()));
} else {
  process.exitCode = await runCli(args, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
  });
}
