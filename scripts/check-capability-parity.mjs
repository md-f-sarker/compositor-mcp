#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const router = await readFile(path.join(root, "compositor/Compositor/MCP/CompositorMCPCommandRouter.swift"), "utf8");

// The capability registry is the source of truth — import the built package
// rather than regex-scraping the TypeScript source (`npm run check` runs
// build:protocol first).
const distEntry = path.join(root, "packages/protocol/dist/index.js");
let registry;
try {
  registry = await import(pathToFileURL(distEntry).href);
} catch (error) {
  console.error(`Could not load ${distEntry}. Run \`npm run build:protocol\` first.\n${error}`);
  process.exit(1);
}
const { CAPABILITIES } = registry;

const all = CAPABILITIES.map((entry) => entry.name);
const implemented = CAPABILITIES.filter((entry) => entry.status === "implemented");
const planned = CAPABILITIES.filter((entry) => entry.status === "planned");

function swiftSet(name) {
  const match = router.match(new RegExp(`private let ${name}: Set<String> = \\[([\\s\\S]*?)\\]`));
  if (!match) throw new Error(`Could not find Swift ${name} capability set.`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

const swiftImplemented = swiftSet("implemented");
const swiftDestructive = swiftSet("destructive");
const swiftNonTransactional = swiftSet("nonTransactional");
const swiftReadOnly = swiftSet("readOnly");

const duplicates = (values) => [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
const difference = (left, right) => left.filter((value) => !right.includes(value));
const names = (values) => values.map((entry) => entry.name);

const expectedImplemented = names(implemented);
const expectedDestructive = names(implemented.filter((entry) => entry.risk === "destructive"));
const expectedReadOnly = names(implemented.filter((entry) => entry.risk === "read"));
const expectedNonTransactional = names(implemented.filter((entry) => !entry.transactional && entry.risk !== "read"));

const report = {
  duplicateNames: duplicates(all),
  duplicateSwiftImplemented: duplicates(swiftImplemented),
  missingInSwift: difference(expectedImplemented, swiftImplemented),
  missingInCatalogue: difference(swiftImplemented, expectedImplemented),
  destructiveMissingInSwift: difference(expectedDestructive, swiftDestructive),
  destructiveUnexpectedInSwift: difference(swiftDestructive, expectedDestructive),
  readOnlyMissingInSwift: difference(expectedReadOnly, swiftReadOnly),
  readOnlyUnexpectedInSwift: difference(swiftReadOnly, expectedReadOnly),
  nonTransactionalMissingInSwift: difference(expectedNonTransactional, swiftNonTransactional),
  nonTransactionalUnexpectedInSwift: difference(swiftNonTransactional, expectedNonTransactional),
};

if (Object.values(report).some((values) => values.length > 0)) {
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} else {
  console.log(`Capability parity OK: ${implemented.length} implemented, ${planned.length} planned, ${all.length} total; risk and transaction classes agree.`);
}
