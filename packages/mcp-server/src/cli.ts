import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject, JsonValue } from "@compositor-mcp/protocol";
import { SocketBridgeTransport, type BridgeTransport } from "./bridge-client.js";
import { normaliseError } from "./errors.js";
import { MockBridgeTransport } from "./mock-bridge.js";

/// Output channels and environment are injectable so tests can drive the CLI
/// in-process without touching the user's real discovery or config paths.
export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
}

export const USAGE = `compositor-mcp — MCP server and bridge tooling for Compositor

Usage:
  compositor-mcp                          Run the MCP server over stdio (default)
  compositor-mcp serve                    Same as above, explicitly
  compositor-mcp doctor                   Verify the discovery file, bridge and configuration
  compositor-mcp install-bridge <dir>     Install the native bridge into a Compositor checkout
  compositor-mcp configure <dir> [...]    Authorize filesystem roots for file operations
  compositor-mcp --help                   Show this help

Environment:
  COMPOSITOR_MCP_BRIDGE_FILE   Override the bridge discovery file path
  COMPOSITOR_MCP_CONFIG_DIR    Override the bridge configuration directory
  COMPOSITOR_MCP_TIMEOUT_MS    Bridge request timeout in milliseconds (default 30000)
  COMPOSITOR_MCP_MOCK=1        Serve/diagnose against the built-in mock bridge
`;

const EXIT_USAGE = 64;
const EXIT_NO_INPUT = 66;
const EXIT_UNAVAILABLE = 69;
const EXIT_SOFTWARE = 70;

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "--help":
    case "-h":
    case "help":
      io.out(USAGE);
      return 0;
    case "doctor":
      return doctor(rest, io);
    case "install-bridge":
      return installBridge(rest, io);
    case "configure":
      return configure(rest, io);
    default:
      io.err(`Unknown command: ${command ?? ""}`.trimEnd());
      io.err(USAGE);
      return EXIT_USAGE;
  }
}

// --- doctor -----------------------------------------------------------------

async function doctor(args: string[], io: CliIo): Promise<number> {
  if (args.length > 0) {
    io.err("doctor takes no arguments.");
    return EXIT_USAGE;
  }

  const mock = io.env.COMPOSITOR_MCP_MOCK === "1";
  const transport: BridgeTransport = mock
    ? new MockBridgeTransport()
    : new SocketBridgeTransport(
        io.env.COMPOSITOR_MCP_BRIDGE_FILE ? { discoveryPath: io.env.COMPOSITOR_MCP_BRIDGE_FILE } : {},
      );

  try {
    const lines: string[] = [];
    if (transport instanceof SocketBridgeTransport) {
      const discovery = await transport.readDiscovery();
      const metadata = await fs.stat(transport.discoveryPath);
      const mode = (metadata.mode & 0o777).toString(8).padStart(4, "0");
      lines.push(`discovery file: ${transport.discoveryPath}`);
      lines.push(`  mode ${mode} (owner-only), host ${discovery.host}:${discovery.port} (loopback)`);
    } else {
      lines.push("discovery file: skipped (COMPOSITOR_MCP_MOCK=1)");
    }

    const ping = asObject(await transport.request("ping"));
    const capabilitiesValue = await transport.request("capabilities");
    // The real bridge answers { protocol, implemented: [...], revision }; the
    // mock transport returns the raw catalogue array instead.
    const capabilities = asObject(capabilitiesValue);
    const implemented = Array.isArray(capabilitiesValue)
      ? capabilitiesValue.filter((entry) => asObject(entry as JsonValue)["status"] === "implemented").length
      : Array.isArray(capabilities["implemented"])
        ? capabilities["implemented"].length
        : 0;
    const revision = typeof capabilities["revision"] === "number" ? capabilities["revision"] : ping["revision"];
    const appVersion = typeof ping["appVersion"] === "string" ? ping["appVersion"] : "unknown";
    const protocol = typeof ping["protocol"] === "string" ? ping["protocol"] : "unknown";

    lines.push(`bridge:         reachable${typeof ping["processId"] === "number" ? ` (pid ${ping["processId"]})` : ""}`);
    lines.push(`app version:    ${appVersion}`);
    lines.push(`protocol:       ${protocol}`);
    lines.push(`capabilities:   ${implemented} implemented`);
    lines.push(`revision:       ${typeof revision === "number" ? revision : "unknown"}`);

    const roots = await readConfiguredRoots(configDir(io.env));
    if (roots === null) {
      lines.push("authorized roots: none configured (run `compositor-mcp configure <dir...>`)");
    } else if (roots.length === 0) {
      lines.push("authorized roots: [] (filesystem operations denied)");
    } else {
      lines.push("authorized roots:");
      for (const root of roots) lines.push(`  - ${root}`);
    }

    for (const line of lines) io.out(line);
    io.out("OK — the Compositor bridge is healthy.");
    return 0;
  } catch (error) {
    const failure = normaliseError(error);
    io.err("compositor-mcp doctor: FAILED");
    io.err(`  code:    ${failure.code}`);
    io.err(`  message: ${failure.message}`);
    if (failure.code === "bridge_not_running" || failure.code === "bridge_connection_failed" || failure.code === "bridge_timeout" || failure.code === "bridge_closed") {
      io.err("");
      io.err("Next steps:");
      io.err("  1. Install the bridge into your Compositor checkout:");
      io.err("       npx -y compositor-mcp install-bridge /path/to/Compositor");
      io.err("  2. Open Compositor.xcodeproj, build and run the Compositor scheme.");
      io.err("  3. Authorize filesystem roots for file operations:");
      io.err("       npx -y compositor-mcp configure \"$HOME/Pictures\"");
      io.err("  4. Re-run: npx -y compositor-mcp doctor");
    }
    return 1;
  }
}

async function readConfiguredRoots(directory: string): Promise<string[] | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(directory, "config.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return Array.isArray(parsed["allowedRoots"]) ? parsed["allowedRoots"].filter((root): root is string => typeof root === "string") : [];
  } catch {
    return null;
  }
}

// --- install-bridge ---------------------------------------------------------

async function installBridge(args: string[], io: CliIo): Promise<number> {
  if (args.length !== 1 || args[0] === undefined || args[0].startsWith("-")) {
    io.err("Usage: compositor-mcp install-bridge /absolute/path/to/Compositor");
    return EXIT_USAGE;
  }

  const script = await resolveInstaller(io.env);
  if (script === null) {
    io.err("The bundled installer is missing from this package; reinstall compositor-mcp.");
    return EXIT_SOFTWARE;
  }

  // Inherit the ambient environment (the installer needs PATH for git/python3)
  // with the caller's overrides layered on top.
  const result = spawnSync("bash", [script, args[0]], { encoding: "utf8", env: { ...process.env, ...io.env } });
  if (result.error) {
    io.err(`Failed to run ${script}: ${result.error.message}`);
    return EXIT_UNAVAILABLE;
  }
  if (result.stdout) io.out(result.stdout.trimEnd());
  if (result.stderr) io.err(result.stderr.trimEnd());
  return result.status ?? 1;
}

/// Resolution order: explicit override, the assets staged by prepack inside the
/// published tarball, then the monorepo checkout (dev/test convenience). The
/// repo fallback is gated on a sibling protocol workspace so an installed
/// package never picks up an unrelated user script.
async function resolveInstaller(env: NodeJS.ProcessEnv): Promise<string | null> {
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const candidates = [
    env.COMPOSITOR_MCP_INSTALLER,
    path.join(packageRoot, "assets", "scripts", "install-into-compositor.sh"),
  ];
  try {
    await fs.access(path.join(repoRoot, "packages", "protocol", "package.json"));
    candidates.push(path.join(repoRoot, "scripts", "install-into-compositor.sh"));
  } catch {
    // Not a monorepo checkout — only bundled assets apply.
  }
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

// --- configure ---------------------------------------------------------------

async function configure(args: string[], io: CliIo): Promise<number> {
  if (args.length === 0) {
    io.err("Usage: compositor-mcp configure /allowed/root [/another/root ...]");
    io.err("Example: compositor-mcp configure \"$HOME/Pictures\" \"$HOME/Downloads\"");
    return EXIT_USAGE;
  }

  const roots: string[] = [];
  for (const raw of args) {
    const resolved = path.resolve(expandHome(raw, io.env));
    const metadata = await fs.stat(resolved).catch(() => null);
    if (metadata === null || !metadata.isDirectory()) {
      io.err(`Allowed root is not a directory: ${resolved}`);
      return EXIT_NO_INPUT;
    }
    roots.push(resolved);
  }

  const directory = configDir(io.env);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const file = path.join(directory, "config.json");
  const body = JSON.stringify({ enabled: true, allowedRoots: roots, auditLogging: true }, null, 2) + "\n";
  await fs.writeFile(file, body, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(file, 0o600);
  io.out(`Wrote ${file}`);
  io.out("Restart Compositor to reload the bridge configuration.");
  return 0;
}

function configDir(env: NodeJS.ProcessEnv): string {
  return env.COMPOSITOR_MCP_CONFIG_DIR ?? path.join(os.homedir(), "Library", "Application Support", "Compositor", "MCP");
}

function expandHome(input: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? os.homedir();
  if (input === "~") return home;
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
}

function asObject(value: JsonValue): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
