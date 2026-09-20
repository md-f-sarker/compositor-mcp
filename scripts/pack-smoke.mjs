#!/usr/bin/env node
// Packs compositor-mcp, installs the tarball into a scratch project and runs
// the packed CLI — the release-safety smoke shared by ci.yml and release.yml.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  execFileSync(path.join(project, "node_modules", ".bin", "compositor-mcp"), ["--help"], { stdio: "inherit" });
  console.log("pack smoke OK — the packed CLI runs.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
