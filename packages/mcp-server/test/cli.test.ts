import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@compositor-mcp/protocol";
import { runCli, USAGE, type CliIo } from "../src/cli.js";

const repoInstaller = fileURLToPath(new URL("../../../scripts/install-into-compositor.sh", import.meta.url));

function captureIo(env: NodeJS.ProcessEnv = {}): { io: CliIo; stdout: () => string; stderr: () => string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    env,
  };
  return { io, stdout: () => stdout.join("\n"), stderr: () => stderr.join("\n") };
}

/// The representative upstream delegate the installer patches — shared with
/// the CI installer smoke test so both exercise the same source file.
const DELEGATE_FIXTURE = fileURLToPath(new URL("fixtures/AppDelegate.fixture.swift", import.meta.url));

async function makeCompositorTree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "compositor-upstream-"));
  await fs.mkdir(path.join(root, "Compositor.xcodeproj"), { recursive: true });
  await fs.mkdir(path.join(root, "Compositor", "IO"), { recursive: true });
  await fs.copyFile(DELEGATE_FIXTURE, path.join(root, "Compositor", "IO", "CompositorApplicationDelegate.swift"));
  return root;
}

async function withFakeBridge(
  respond: (method: string, params: unknown) => JsonValue,
  body: (discoveryFile: string) => Promise<void>,
): Promise<void> {
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const request = JSON.parse(line) as { id: string; method: string; params?: unknown };
      socket.write(
        `${JSON.stringify({ protocol: "compositor-bridge/1", id: request.id, ok: true, result: respond(request.method, request.params) })}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "compositor-mcp-cli-"));
  const discoveryFile = path.join(directory, "bridge.json");
  await fs.writeFile(
    discoveryFile,
    JSON.stringify({
      protocol: "compositor-bridge/1",
      host: "127.0.0.1",
      port,
      token: "b".repeat(64),
      pid: process.pid,
      startedAt: new Date().toISOString(),
      appVersion: "9.9.9-test",
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.chmod(discoveryFile, 0o600);
  try {
    await body(discoveryFile);
  } finally {
    server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("--help prints usage and exits zero", async () => {
  const { io, stdout } = captureIo();
  assert.equal(await runCli(["--help"], io), 0);
  assert.match(stdout(), /install-bridge/);
  assert.match(stdout(), /doctor/);
});

test("an unknown command exits with usage status", async () => {
  const { io, stderr } = captureIo();
  assert.equal(await runCli(["frobnicate"], io), 64);
  assert.match(stderr(), /Unknown command: frobnicate/);
});

test("doctor against the mock bridge reports a healthy summary", async () => {
  const { io, stdout } = captureIo({ COMPOSITOR_MCP_MOCK: "1" });
  assert.equal(await runCli(["doctor"], io), 0);
  assert.match(stdout(), /capabilities:\s+\d+ implemented/);
  assert.match(stdout(), /revision:/);
  assert.match(stdout(), /OK — the Compositor bridge is healthy/);
});

test("doctor against a live bridge prints version, capabilities and roots", async () => {
  const rootsDir = await fs.mkdtemp(path.join(os.tmpdir(), "compositor-mcp-config-"));
  const pictures = path.join(rootsDir, "Pictures");
  await fs.mkdir(pictures);
  try {
    await withFakeBridge(
      (method) => {
        if (method === "ping") {
          return { ok: true, protocol: "compositor-bridge/1", revision: 7, processId: process.pid, appVersion: "9.9.9-test" };
        }
        if (method === "capabilities") {
          return { protocol: "compositor-bridge/1", implemented: ["app.ping", "app.getState", "layer.list"], revision: 7 };
        }
        return null;
      },
      async (discoveryFile) => {
        const { io, stdout } = captureIo({
          COMPOSITOR_MCP_BRIDGE_FILE: discoveryFile,
          COMPOSITOR_MCP_CONFIG_DIR: rootsDir,
        });
        await fs.writeFile(
          path.join(rootsDir, "config.json"),
          JSON.stringify({ enabled: true, allowedRoots: [pictures], auditLogging: true }),
        );
        assert.equal(await runCli(["doctor"], io), 0);
        assert.match(stdout(), /9\.9\.9-test/);
        assert.match(stdout(), /compositor-bridge\/1/);
        assert.match(stdout(), /3 implemented/);
        assert.match(stdout(), /revision:\s+7/);
        assert.match(stdout(), new RegExp(pictures.replace(/[/.]/g, "\\$&")));
      },
    );
  } finally {
    await fs.rm(rootsDir, { recursive: true, force: true });
  }
});

test("doctor with no discovery file fails with bridge_not_running guidance", async () => {
  const { io, stderr } = captureIo({
    COMPOSITOR_MCP_BRIDGE_FILE: path.join(os.tmpdir(), `missing-bridge-${Date.now()}.json`),
  });
  assert.equal(await runCli(["doctor"], io), 1);
  assert.match(stderr(), /bridge_not_running/);
  assert.match(stderr(), /install-bridge/);
});

test("doctor refuses a world-readable discovery file", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "compositor-mcp-cli-"));
  const file = path.join(directory, "bridge.json");
  await fs.writeFile(file, JSON.stringify({ protocol: "compositor-bridge/1" }), { mode: 0o644 });
  await fs.chmod(file, 0o644);
  try {
    const { io, stderr } = captureIo({ COMPOSITOR_MCP_BRIDGE_FILE: file });
    assert.equal(await runCli(["doctor"], io), 1);
    assert.match(stderr(), /unsafe_bridge_discovery/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("configure writes owner-only config.json with resolved roots", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "compositor-mcp-config-"));
  const pictures = path.join(directory, "My Pictures");
  const configDir = path.join(directory, "MCP");
  await fs.mkdir(pictures);
  try {
    const { io, stdout } = captureIo({ COMPOSITOR_MCP_CONFIG_DIR: configDir });
    assert.equal(await runCli(["configure", pictures], io), 0);
    const file = path.join(configDir, "config.json");
    assert.match(stdout(), new RegExp(`Wrote ${file.replace(/[/.]/g, "\\$&")}`));
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { enabled: boolean; allowedRoots: string[]; auditLogging: boolean };
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.auditLogging, true);
    assert.deepEqual(parsed.allowedRoots, [pictures]);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(configDir)).mode & 0o777, 0o700);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("configure merges an existing config.json instead of clobbering its flags", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "compositor-mcp-config-"));
  const pictures = path.join(directory, "Pictures");
  const downloads = path.join(directory, "Downloads");
  const configDir = path.join(directory, "MCP");
  await fs.mkdir(pictures);
  await fs.mkdir(downloads);
  await fs.mkdir(configDir, { recursive: true });
  try {
    // A user who disabled the bridge and its audit log must not be re-enabled
    // by re-running configure; allowedRoots is the field the command owns.
    await fs.writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ enabled: false, allowedRoots: [pictures], auditLogging: false, futureKey: "kept" }),
    );
    const { io } = captureIo({ COMPOSITOR_MCP_CONFIG_DIR: configDir });
    assert.equal(await runCli(["configure", downloads], io), 0);
    const parsed = JSON.parse(await fs.readFile(path.join(configDir, "config.json"), "utf8")) as {
      enabled: boolean;
      allowedRoots: string[];
      auditLogging: boolean;
      futureKey?: string;
    };
    assert.equal(parsed.enabled, false);
    assert.equal(parsed.auditLogging, false);
    assert.ok(parsed.allowedRoots.includes(downloads));
    assert.equal(parsed.futureKey, "kept");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("configure expands ~ and rejects non-directories", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "compositor-mcp-home-"));
  const configDir = path.join(home, "MCP");
  try {
    const missing = captureIo({ COMPOSITOR_MCP_CONFIG_DIR: configDir, HOME: home });
    assert.equal(await runCli(["configure", "~/definitely-not-here"], missing.io), 66);
    assert.match(missing.stderr(), /not a directory/);

    const noArgs = captureIo({ COMPOSITOR_MCP_CONFIG_DIR: configDir });
    assert.equal(await runCli(["configure"], noArgs.io), 64);

    const tilde = captureIo({ COMPOSITOR_MCP_CONFIG_DIR: configDir, HOME: home });
    assert.equal(await runCli(["configure", "~"], tilde.io), 0);
    const parsed = JSON.parse(await fs.readFile(path.join(configDir, "config.json"), "utf8")) as { allowedRoots: string[] };
    assert.deepEqual(parsed.allowedRoots, [home]);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("install-bridge copies sources, patches the delegate and is idempotent", async () => {
  const root = await makeCompositorTree();
  try {
    const env = { COMPOSITOR_MCP_INSTALLER: repoInstaller };
    const first = captureIo(env);
    assert.equal(await runCli(["install-bridge", root], first.io), 0);
    assert.match(first.stdout(), /Installed Compositor MCP bridge sources/);
    assert.match(first.stdout(), /a19db9011282399785dc18efcfded904627bdcc2/);
    assert.match(first.stderr(), /not a git checkout/);

    assert.ok(await exists(path.join(root, "Compositor", "MCP", "CompositorMCPBridge.swift")));
    const patched = await fs.readFile(path.join(root, "Compositor", "IO", "CompositorApplicationDelegate.swift"), "utf8");
    assert.match(patched, /bridge\.start\(\)/);

    const second = captureIo(env);
    assert.equal(await runCli(["install-bridge", root], second.io), 0);
    assert.match(second.stdout(), /Already patched/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("install-bridge warns on upstream drift but proceeds and records both SHAs", async () => {
  const root = await makeCompositorTree();
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-qm", "fixture", "--allow-empty"], { cwd: root });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    assert.notEqual(head, "a19db9011282399785dc18efcfded904627bdcc2");

    const { io, stdout, stderr } = captureIo({ COMPOSITOR_MCP_INSTALLER: repoInstaller });
    assert.equal(await runCli(["install-bridge", root], io), 0);
    assert.match(stderr(), /upstream drift detected/);
    assert.match(stdout(), /a19db9011282399785dc18efcfded904627bdcc2/);
    assert.match(stdout(), new RegExp(head));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("install-bridge preserves the exit-66 diagnostic for non-Compositor paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "not-compositor-"));
  try {
    const { io, stderr } = captureIo({ COMPOSITOR_MCP_INSTALLER: repoInstaller });
    assert.equal(await runCli(["install-bridge", root], io), 66);
    assert.match(stderr(), /Not a Compositor checkout/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("install-bridge requires exactly one path", async () => {
  const { io } = captureIo({ COMPOSITOR_MCP_INSTALLER: repoInstaller });
  assert.equal(await runCli(["install-bridge"], io), 64);
});

test("USAGE mentions all subcommands", () => {
  for (const word of ["serve", "doctor", "install-bridge", "configure", "--help"]) {
    assert.match(USAGE, new RegExp(word));
  }
});

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
