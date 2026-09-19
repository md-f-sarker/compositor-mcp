#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogue = await readFile(path.join(root, "packages/protocol/src/capabilities.ts"), "utf8");
const router = await readFile(path.join(root, "compositor/Compositor/MCP/CompositorMCPCommandRouter.swift"), "utf8");

const capabilityChunks = catalogue.split("capability({").slice(1);
const all = [];
const entries = [];
for (const chunk of capabilityChunks) {
  const match = chunk.match(/\bname:\s*"([^"]+)"/);
  if (!match) continue;
  const name = match[1];
  const status = /\bstatus:\s*"planned"/.test(chunk) ? "planned" : "implemented";
  const risk = chunk.match(/\brisk:\s*"([^"]+)"/)?.[1] ?? "write";
  const transactional = !/\btransactional:\s*false/.test(chunk);
  all.push(name);
  entries.push({ name, status, risk, transactional });
}

const implemented = entries.filter((entry) => entry.status === "implemented");
const planned = entries.filter((entry) => entry.status === "planned");

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
