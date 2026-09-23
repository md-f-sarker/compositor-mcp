import { CAPABILITIES } from "./capabilities.js";
import type { Capability, CapabilitySearchHit, SearchOptions } from "./types.js";

const normalise = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const tokens = (value: string): string[] => normalise(value).split(/\s+/).filter(Boolean);

/// A capability with every scored field pre-normalised — computed once at load
/// so a query never re-normalises all 62 catalogue entries.
interface SearchRecord {
  capability: Capability;
  name: string;
  title: string;
  aliases: string[];
  tags: string[];
  description: string;
  category: string;
}

const SEARCH_RECORDS: SearchRecord[] = CAPABILITIES.map((capability) => ({
  capability,
  name: normalise(capability.name),
  title: normalise(capability.title),
  aliases: capability.aliases.map(normalise),
  tags: capability.tags.map(normalise),
  description: normalise(capability.description),
  category: normalise(capability.category),
}));

function scoreCapability(query: string, record: SearchRecord): number {
  const entry = record.capability;
  const q = normalise(query);
  if (!q) return entry.status === "implemented" ? 1 : 0.5;

  const queryTokens = tokens(q);
  const { name, title, aliases, tags, description, category } = record;

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

/// Match plus the full capability — internally richer than CapabilitySearchHit,
/// whose unioned `capability` field loses `inputSchema`/`examples` access.
interface ScoredMatch {
  score: number;
  capability: Capability;
}

function scoredMatches(query: string, includePlanned: boolean): ScoredMatch[] {
  return SEARCH_RECORDS
    .filter((record) => includePlanned || record.capability.status === "implemented")
    .map((record) => ({ score: scoreCapability(query, record), capability: record.capability }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.capability.name.localeCompare(b.capability.name));
}

export function searchCapabilities(query: string, options: SearchOptions = {}): CapabilitySearchHit[] {
  const limit = Math.max(1, Math.min(50, options.limit ?? 10));
  const includeSchemas = options.includeSchemas ?? true;
  const includePlanned = options.includePlanned ?? false;

  return scoredMatches(query, includePlanned)
    .slice(0, limit)
    .map((hit) => {
      if (includeSchemas) return hit;
      const { inputSchema: _schema, examples: _examples, ...summary } = hit.capability;
      return { score: hit.score, capability: summary };
    });
}

/// The full match count for a query, without the public 50-result cap — lets
/// callers report a true `total` even when the response itself is truncated.
export function countCapabilityMatches(query: string, options: SearchOptions = {}): number {
  return scoredMatches(query, options.includePlanned ?? false).length;
}
