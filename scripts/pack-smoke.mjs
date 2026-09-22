#!/usr/bin/env node
// Packs compositor-mcp, installs the tarball into a scratch project and runs
// the packed CLI — the release-safety smoke shared by ci.yml and release.yml.
// Beyond "the bin starts", this exercises the bundled bridge installer
// end-to-end: the packed package's own assets must be able to patch a
// representative Compositor checkout.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(path.join(tmpdir(), "compositor-mcp-pack-"));

try {
  // npm pack prints the tarball filename as its last stdout line; prepack
  // rebuilds dist and syncs the bundled assets automatically.
  const packed = execFileSync("npm", ["pack", "-w", "compositor-mcp", "--pack-destination", scratch], {
    cwd: root,
    encoding: "utf8",
  });
  const tarball = path.join(scratch, packed.trim().split("\n").at(-1));

  const project = path.join(scratch, "project");
  mkdirSync(project);
  execFileSync("npm", ["init", "-y"], { cwd: project, stdio: "ignore" });
  execFileSync("npm", ["install", tarball], { cwd: project, stdio: "inherit" });

  const installed = path.join(project, "node_modules", "compositor-mcp");
  const bin = path.join(project, "node_modules", ".bin", "compositor-mcp");
  execFileSync(bin, ["--help"], { stdio: "inherit" });

  // The tarball must carry the bundled installer and the Swift sources it
  // copies — install-bridge resolves them from the package when no
  // COMPOSITOR_MCP_INSTALLER override is set.
  const bundledInstaller = path.join(installed, "assets", "scripts", "install-into-compositor.sh");
  if (statSync(bundledInstaller, { throwIfNoEntry: false }) === undefined) {
    throw new Error(`Packed package is missing ${bundledInstaller}`);
  }
  if ((statSync(bundledInstaller).mode & 0o111) === 0) {
    throw new Error(`${bundledInstaller} is not executable in the packed package`);
  }
  const bundledSwiftDir = path.join(installed, "assets", "compositor", "Compositor", "MCP");
  const bundledSwift = readdirSync(bundledSwiftDir, { withFileTypes: false }).filter((entry) => entry.endsWith(".swift"));
  if (bundledSwift.length === 0) {
    throw new Error(`Packed package bundles no Swift bridge sources under ${bundledSwiftDir}`);
  }

  // Minimal Compositor checkout: the installer needs the xcodeproj directory,
  // the app delegate it patches, and reads HEAD only when the tree is a git
  // checkout (a plain directory takes the not-a-git-checkout path).
  const fixture = path.join(root, "packages", "mcp-server", "test", "fixtures", "AppDelegate.fixture.swift");
  const compositor = path.join(scratch, "Compositor");
  mkdirSync(path.join(compositor, "Compositor.xcodeproj"), { recursive: true });
  mkdirSync(path.join(compositor, "Compositor", "IO"), { recursive: true });
  copyFileSync(fixture, path.join(compositor, "Compositor", "IO", "CompositorApplicationDelegate.swift"));
  writeFileSync(
    path.join(compositor, "Compositor.xcodeproj", "project.pbxproj"),
    "\t\tCODE_SIGN_ENTITLEMENTS = Config/Compositor.entitlements;\n\t\tENABLE_APP_SANDBOX = YES;\n",
  );

  const env = { ...process.env };
  delete env.COMPOSITOR_MCP_INSTALLER;
  const installOutput = execFileSync(bin, ["install-bridge", compositor], { encoding: "utf8", env });
  if (!/Installed Compositor MCP bridge sources/.test(installOutput)) {
    throw new Error(`Packed install-bridge did not report success:\n${installOutput}`);
  }
  if (statSync(path.join(compositor, "Compositor", "MCP", "CompositorMCPBridge.swift"), { throwIfNoEntry: false }) === undefined) {
    throw new Error("install-bridge ran but copied no Swift sources into the checkout");
  }
  const patched = readFileSync(path.join(compositor, "Compositor", "IO", "CompositorApplicationDelegate.swift"), "utf8");
  if (!patched.includes("bridge.start()")) {
    throw new Error("install-bridge ran but the app delegate was not patched");
  }

  console.log(`pack smoke OK — the packed CLI runs and its bundled installer patched a fixture checkout (${bundledSwift.length} Swift sources).`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
