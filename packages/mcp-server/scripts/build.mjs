#!/usr/bin/env node
// Bundles the MCP server into a single ESM file at dist/index.js.
// The workspace-only @compositor-mcp/protocol package is inlined from its
// TypeScript sources so the published tarball has no private dependencies;
// real npm dependencies (@modelcontextprotocol/server, zod) stay external.
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const protocolEntry = path.resolve(packageDir, "..", "protocol", "src", "index.ts");

await build({
  entryPoints: [path.join(packageDir, "src", "index.ts")],
  outfile: path.join(packageDir, "dist", "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
  alias: {
    "@compositor-mcp/protocol": protocolEntry,
  },
  external: [
    "@modelcontextprotocol/server",
    "@modelcontextprotocol/server/*",
    "zod",
    "zod/*",
  ],
});
