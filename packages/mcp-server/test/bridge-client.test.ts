import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SocketBridgeTransport } from "../src/bridge-client.js";
import { CompositorMcpError } from "../src/errors.js";

// The pid must name a live process — readDiscovery treats a dead pid as a
// stale discovery file left behind by a quit Compositor.
const validDiscovery = {
  protocol: "compositor-bridge/1",
  host: "127.0.0.1",
  port: 49152,
  token: "a".repeat(64),
  pid: process.pid,
  startedAt: "2026-09-19T10:00:00Z",
};

async function withDiscovery(
  value: unknown,
  mode: number,
  body: (file: string) => Promise<void>,
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "compositor-mcp-server-test-"));
  const file = path.join(directory, "bridge.json");
  try {
    await fs.writeFile(file, JSON.stringify(value), { encoding: "utf8", mode });
    await fs.chmod(file, mode);
    await body(file);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("bridge discovery accepts a secure loopback configuration", async () => {
  await withDiscovery(validDiscovery, 0o600, async (file) => {
    const result = await new SocketBridgeTransport({ discoveryPath: file }).readDiscovery();
    assert.equal(result.host, "127.0.0.1");
    assert.equal(result.port, 49152);
  });
});

test("bridge discovery preserves unsafe-permission errors", async () => {
  await withDiscovery(validDiscovery, 0o644, async (file) => {
    await assert.rejects(
      () => new SocketBridgeTransport({ discoveryPath: file }).readDiscovery(),
      (error: unknown) => error instanceof CompositorMcpError && error.code === "unsafe_bridge_discovery",
    );
  });
});

test("bridge discovery treats a dead pid as a stale bridge", async () => {
  // PID 2^30 is past every platform's pid ceiling — it cannot be running.
  await withDiscovery({ ...validDiscovery, pid: 1 << 30 }, 0o600, async (file) => {
    await assert.rejects(
      () => new SocketBridgeTransport({ discoveryPath: file }).readDiscovery(),
      (error: unknown) => error instanceof CompositorMcpError && error.code === "bridge_not_running",
    );
  });
});

test("bridge discovery rejects invalid process and timestamp fields", async () => {
  await withDiscovery({ ...validDiscovery, pid: 0, startedAt: "not-a-date" }, 0o600, async (file) => {
    await assert.rejects(
      () => new SocketBridgeTransport({ discoveryPath: file }).readDiscovery(),
      (error: unknown) => error instanceof CompositorMcpError && error.code === "invalid_bridge_discovery",
    );
  });
});

test("a missing bridge discovery file is reported as not running", async () => {
  const file = path.join(os.tmpdir(), `missing-compositor-bridge-${Date.now()}.json`);
  await assert.rejects(
    () => new SocketBridgeTransport({ discoveryPath: file }).readDiscovery(),
    (error: unknown) => error instanceof CompositorMcpError && error.code === "bridge_not_running" && error.retryable,
  );
});
