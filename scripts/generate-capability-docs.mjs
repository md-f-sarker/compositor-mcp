#!/usr/bin/env node
// Generates docs/capabilities.md from the capability registry, the single source of truth.
// Usage:
//   node scripts/generate-capability-docs.mjs          # rewrite docs/capabilities.md
//   node scripts/generate-capability-docs.mjs --check  # fail if the committed file is stale
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const outputPath = path.join(root, "docs", "capabilities.md");

const distEntry = path.join(root, "packages/protocol/dist/index.js");
let registry;
try {
  registry = await import(pathToFileURL(distEntry).href);
} catch (error) {
  console.error(`Could not load ${distEntry}. Run \`npm run build:protocol\` first.\n${error}`);
  process.exit(1);
}
const { CAPABILITIES } = registry;

const cell = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");

// Collect property names across a schema's branches, marking a name required only when
// every branch that declares it requires it.
function parameterSummary(schema) {
  const branches = schema.oneOf ?? schema.anyOf ?? [schema];
  const seen = new Map();
  for (const branch of branches) {
    const required = new Set(branch.required ?? []);
    for (const name of Object.keys(branch.properties ?? {})) {
      const entry = seen.get(name) ?? { declared: 0, required: 0 };
      entry.declared += 1;
      if (required.has(name)) entry.required += 1;
      seen.set(name, entry);
    }
  }
  if (seen.size === 0) return "–";
  return [...seen.entries()]
    .map(([name, entry]) => (entry.required === entry.declared ? `\`${name}\`` : `\`${name}\`?`))
    .join(", ");
}

function searchTerms(capability) {
  const parts = [];
  if (capability.aliases.length > 0) parts.push(`aliases: ${capability.aliases.join(", ")}`);
  if (capability.tags.length > 0) parts.push(`tags: ${capability.tags.join(", ")}`);
  return parts.length > 0 ? parts.join("; ") : "–";
}

const implemented = CAPABILITIES.filter((entry) => entry.status === "implemented");
const planned = CAPABILITIES.filter((entry) => entry.status === "planned");

const categories = new Map();
for (const capability of CAPABILITIES) {
  const list = categories.get(capability.category) ?? [];
  list.push(capability);
  categories.set(capability.category, list);
}

const lines = [
  "# Capability reference",
  "",
  "_Generated from `packages/protocol/src/capabilities.ts` by `scripts/generate-capability-docs.mjs`._",
  "_Do not edit by hand — run `npm run docs:capabilities` and commit the result._",
  "",
  `${CAPABILITIES.length} operations: ${implemented.length} implemented, ${planned.length} planned.`,
  "`execute` rejects `planned` operations with `operation_not_implemented` until the bridge implements them.",
  "",
  "**Risk** — `read`: no mutation; `write`: mutates the document; `destructive`: requires",
  "`confirmDestructive: true`; `filesystem`: reads or writes inside authorised roots.",
  "**Txn** — `yes`: participates in atomic `execute` batches; `no`: excluded from atomic rollback.",
  "Parameters in `code` are required; a trailing `?` marks optional arguments.",
  "",
];

for (const [category, entries] of categories) {
  lines.push(`## ${category}`);
  lines.push("");
  lines.push("| Operation | Title | Status | Risk | Txn | Parameters | Aliases & tags |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const capability of entries) {
    lines.push(
      `| \`${capability.name}\` | ${cell(capability.title)} | ${capability.status} | ${capability.risk} | ` +
        `${capability.transactional ? "yes" : "no"} | ${parameterSummary(capability.inputSchema)} | ${cell(searchTerms(capability))} |`,
    );
  }
  lines.push("");
}

lines.push("## Argument conventions");
lines.push("");
lines.push("- `layerId` accepts a layer UUID or `active`; `projectId` accepts a UUID or `current`.");
lines.push("- Points, rects and sizes are document pixels; colours are `#RRGGBB` hex or 0–1 RGB channels.");
lines.push("- `adjustment.*` and `filter.apply` pair a `kind` constant with a typed `parameters`/`settings`");
lines.push("  object via `oneOf` — each kind accepts only its own fields.");
lines.push("");

const content = lines.join("\n");

if (check) {
  let current = null;
  try {
    current = await readFile(outputPath, "utf8");
  } catch {
    // missing file counts as stale
  }
  if (current !== content) {
    console.error("docs/capabilities.md is stale — regenerate it with `npm run docs:capabilities`.");
    process.exit(1);
  }
  console.log(`docs/capabilities.md is up to date (${CAPABILITIES.length} operations).`);

  // The README advertises the implemented count in prose — catch the drift a
  // registry edit would otherwise leave behind.
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const readmeClaims = [...readme.matchAll(/\b(\d+)\s+(?:catalogued\s+)?operations?\b/g)].map((match) => Number(match[1]));
  if (!readmeClaims.includes(implemented.length)) {
    console.error(
      `README.md does not state the implemented operation count (${implemented.length}); found ${readmeClaims.join(", ") || "none"}.`,
    );
    process.exit(1);
  }
  console.log(`README.md states the implemented operation count (${implemented.length}).`);
} else {
  await writeFile(outputPath, content);
  console.log(`Wrote ${path.relative(root, outputPath)} (${CAPABILITIES.length} operations).`);
}
