#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const swiftDir = path.join(root, "compositor", "Compositor", "MCP");
const router = await readFile(path.join(swiftDir, "CompositorMCPCommandRouter.swift"), "utf8");
const paint = await readFile(path.join(swiftDir, "CompositorMCPPaint.swift"), "utf8");
const filters = await readFile(path.join(swiftDir, "CompositorMCPFilters.swift"), "utf8");

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

// --- Dispatch coverage -------------------------------------------------------
// Every implemented operation must appear as a quoted `case` label in BOTH the
// per-name validation switch and the apply/dispatch switch — the paint and
// filter operations dispatch through the router's grouped cases into the
// validate*/apply* switches living in the extension files.

/// The body of a class/extension member starting at `marker`, cut at the next
/// member declaration (a keyword at exactly four spaces of indentation).
function memberBody(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`Could not find ${marker} in the Swift sources.`);
  const rest = source.slice(start + marker.length);
  const boundary = rest.search(
    /\n {4}(?=(?:private |internal |fileprivate |public |static )*(?:func|struct|class|enum|init|var|let|typealias)\b)/,
  );
  return boundary === -1 ? rest : rest.slice(0, boundary);
}

/// Quoted `case` labels that look like operation names (`domain.verb`), which
/// filters out value cases like "replace", "png" and "from-selection".
function operationCases(source, marker) {
  const body = memberBody(source, marker);
  const names = [];
  for (const labelList of body.matchAll(/case\s+([^:\n]+)/g)) {
    for (const quoted of labelList[1].matchAll(/"([^"]+)"/g)) {
      if (/^[a-z]+\.[a-zA-Z]+$/.test(quoted[1])) names.push(quoted[1]);
    }
  }
  return names;
}

const validateSwitches = [
  operationCases(router, "func validate(_ operation"),
  operationCases(paint, "func validatePaint("),
  operationCases(filters, "func validateFilterAndAdjustment("),
].flat();
const applySwitches = [
  operationCases(router, "func apply(_ operation"),
  operationCases(paint, "func applyPaint("),
  operationCases(filters, "func applyFilterAndAdjustment("),
].flat();

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
  validateDispatchMissing: difference(expectedImplemented, validateSwitches),
  applyDispatchMissing: difference(expectedImplemented, applySwitches),
  dispatchNotCatalogued: difference([...new Set([...validateSwitches, ...applySwitches])], all),
};

if (Object.values(report).some((values) => values.length > 0)) {
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} else {
  console.log(`Capability parity OK: ${implemented.length} implemented, ${planned.length} planned, ${all.length} total; risk, transaction and dispatch coverage agree.`);
}
