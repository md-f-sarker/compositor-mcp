import { CAPABILITIES } from "./capabilities.js";
import type { Capability, CapabilitySearchHit, SearchOptions } from "./types.js";

const normalise = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const tokens = (value: string): string[] => normalise(value).split(/\s+/).filter(Boolean);

function scoreCapability(query: string, entry: Capability): number {
  const q = normalise(query);
  if (!q) return entry.status === "implemented" ? 1 : 0.5;

  const queryTokens = tokens(q);
  const name = normalise(entry.name);
  const title = normalise(entry.title);
  const aliases = entry.aliases.map(normalise);
  const tags = entry.tags.map(normalise);
  const description = normalise(entry.description);
  const category = normalise(entry.category);

  let score = 0;
  if (name === q) score += 100;
  if (title === q) score += 90;
  if (aliases.includes(q)) score += 80;
  if (name.includes(q)) score += 45;
  if (title.includes(q)) score += 35;
  if (aliases.some((value) => value.includes(q))) score += 30;
  if (tags.some((value) => value.includes(q))) score += 24;
  if (category === q) score += 20;
  if (description.includes(q)) score += 12;

  for (const token of queryTokens) {
    if (name.includes(token)) score += 14;
    if (title.includes(token)) score += 11;
    if (aliases.some((value) => value.includes(token))) score += 9;
    if (tags.some((value) => value.includes(token))) score += 7;
    if (category.includes(token)) score += 5;
    if (description.includes(token)) score += 3;
  }

  if (entry.status === "implemented") score += 1;
  return score;
}

export function searchCapabilities(query: string, options: SearchOptions = {}): CapabilitySearchHit[] {
  const limit = Math.max(1, Math.min(50, options.limit ?? 10));
  const includeSchemas = options.includeSchemas ?? true;
  const includePlanned = options.includePlanned ?? false;

  return CAPABILITIES
    .filter((entry) => includePlanned || entry.status === "implemented")
    .map((entry) => ({ score: scoreCapability(query, entry), capability: entry }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.capability.name.localeCompare(b.capability.name))
    .slice(0, limit)
    .map((hit) => {
      if (includeSchemas) return hit;
      const { inputSchema: _schema, examples: _examples, ...summary } = hit.capability;
      return { score: hit.score, capability: summary };
    });
}
