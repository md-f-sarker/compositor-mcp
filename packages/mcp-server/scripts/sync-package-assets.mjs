#!/usr/bin/env node
// Stages the files the published tarball needs beyond dist/:
//   assets/scripts/*.sh                     bridge install/configure/uninstall wrappers
//   assets/compositor/Compositor/MCP/*.swift native bridge sources the installer copies
//   README.md, LICENSE, NOTICE.md, CHANGELOG.md  package-root docs for the npm page
// The assets/ tree mirrors the repository layout so the bundled installer's
// "../compositor/Compositor/MCP" source resolution keeps working unchanged.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const repoRoot = path.resolve(packageDir, "..", "..");

const SHELL_SCRIPTS = [
  "install-into-compositor.sh",
  "configure-compositor.sh",
  "uninstall-from-compositor.sh",
];
const ROOT_DOCS = ["README.md", "LICENSE", "NOTICE.md", "CHANGELOG.md"];

for (const name of SHELL_SCRIPTS) {
  const target = path.join(packageDir, "assets", "scripts", name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(path.join(repoRoot, "scripts", name), target);
  await fs.chmod(target, 0o755);
}

const swiftSourceDir = path.join(repoRoot, "compositor", "Compositor", "MCP");
const swiftTargetDir = path.join(packageDir, "assets", "compositor", "Compositor", "MCP");
await fs.rm(swiftTargetDir, { recursive: true, force: true });
await fs.mkdir(swiftTargetDir, { recursive: true });
for (const entry of await fs.readdir(swiftSourceDir)) {
  if (entry.endsWith(".swift")) {
    await fs.copyFile(path.join(swiftSourceDir, entry), path.join(swiftTargetDir, entry));
  }
}

for (const name of ROOT_DOCS) {
  await fs.copyFile(path.join(repoRoot, name), path.join(packageDir, name));
}

console.log(`Synced ${SHELL_SCRIPTS.length} scripts, ${(await fs.readdir(swiftTargetDir)).length} Swift sources and ${ROOT_DOCS.length} docs into the package.`);
