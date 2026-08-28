// One answer to "which providers are here, and what models does each serve".
//
// Both loaders used to work this out for themselves, from different sources: one counted the
// models the host app's own config had been merged with, the other counted the catalog the
// account library caches per provider. The same home therefore reported different numbers
// depending on which loader you asked, and a provider whose models had been filed under
// another one looked empty in one place and doubled in the other.
//
// The account library's per-provider cache is the source here, because it is the only one
// written per provider; a host app's config is a merge target, not a record of who serves what.

import { existsSync, readFileSync } from "fs";
import { readJson } from "./json.js";
import { join } from "path";
import { readDeployedProviders } from "./loader-runtime.js";
import type { DeployedProvider } from "./loader-runtime.js";

/** One provider's cached catalog, as the account library writes it. */
export interface ProviderCatalogEntry {
  /** The models it serves, by id. */
  models?: Record<string, {
    /** What the model is shown as, when the catalog carries a name for it. */
    name?: string;
  }>;
  /** A score per model, when whoever wrote the catalog had one. */
  scores?: Record<string, number>;
  /** Where those scores came from. */
  scoreSource?: string;
}

/** One model row, across every provider. */
export interface ModelEntry {
  /** The provider serving it. */
  provider: string;
  /** The model id, as that provider names it. */
  model: string;
  /** What it is shown as. */
  name: string;
  /** Its ecosystem-wide id, `provider/model`. */
  id: string;
  /** Its score, when the catalog carried one. */
  score?: number;
  /** Where that score came from. */
  scoreSource?: string;
}

/** One provider row, with how many models it serves. */
export interface ProviderRow {
  /** The provider's name. */
  id: string;
  /** Its handler file, or `null` for a provider only a leftover catalog still names. */
  handler: string | null;
  /** How many models it serves. */
  count: number;
}

/** A model as a provider's own manifest declares it, which may be a bare id. */
type DeclaredModel = string | { id: string; name?: string };

// The pre-rename file is still read so a home that has not refreshed since keeps its catalog.
const CATALOG_FILES = ["models.json", "core-auth-models.json"];

/** The per-provider model catalog the account library caches, or an empty map when there is none to read. */
export function readModelCatalog(configDir: string): Record<string, ProviderCatalogEntry> {
  for (const file of CATALOG_FILES) {
    const at = join(configDir, "config", file);
    if (!existsSync(at)) continue;
    const parsed = readJson<Record<string, ProviderCatalogEntry>>(at);
    // Anything that is not a map of providers is as useless as no catalog, and returning it
    // would have every caller guess at the shape instead.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  }
  return {};
}

/**
 * Every provider deployed here, deduplicated: a plugin can declare several (one per upstream
 * lane) and can add more at runtime through its dynamic manifest.
 */
export function deployedProviders(reposDir: string): DeployedProvider[] {
  const out: DeployedProvider[] = [];
  const seen = new Set<string>();
  for (const entry of readDeployedProviders(reposDir)) {
    if (seen.has(entry.provider)) continue;
    seen.add(entry.provider);
    out.push(entry);
  }
  return out;
}

/**
 * One row per model, across every provider. A provider's live catalog wins; a provider that
 * ships a static list and fetches nothing falls back to that.
 */
export function modelEntries(reposDir: string, configDir: string): ModelEntry[] {
  const catalog = readModelCatalog(configDir);
  const out: ModelEntry[] = [];
  for (const entry of deployedProviders(reposDir)) {
    const provider = entry.provider;
    const cached = catalog[provider] && catalog[provider].models;
    if (cached) {
      const scores = catalog[provider].scores || {};
      const scoreSource = catalog[provider].scoreSource || "";
      for (const model of Object.keys(cached)) {
        out.push({
          provider,
          model,
          name: (cached[model] && cached[model].name) || model,
          id: provider + "/" + model,
          score: typeof scores[model] === "number" ? scores[model] : undefined,
          scoreSource,
        });
      }
      continue;
    }
    for (const declared of (entry.models || []) as DeclaredModel[]) {
      const model = typeof declared === "string" ? declared : declared.id;
      const name = typeof declared === "string" ? declared : (declared.name || declared.id);
      out.push({ provider, model, name, id: provider + "/" + model });
    }
  }
  return out;
}

/**
 * Every provider a loader should list, with the models it serves. A provider with none is
 * still listed and still selectable: antigravity has no catalog until someone logs in, and
 * hiding it would leave no way to log in.
 *
 * A provider with a cached catalog but nothing deployed is listed too, with no handler, so a
 * leftover shows rather than silently disappearing along with the plugin that served it.
 */
export function providerRows(reposDir: string, configDir: string): ProviderRow[] {
  const rows: ProviderRow[] = [];
  const index = new Map<string, ProviderRow>();
  for (const entry of deployedProviders(reposDir)) {
    const row = { id: entry.provider, handler: entry.handlerPath, count: 0 };
    index.set(entry.provider, row);
    rows.push(row);
  }
  for (const entry of modelEntries(reposDir, configDir)) {
    const row = index.get(entry.provider);
    if (row) row.count++;
  }
  for (const provider of Object.keys(readModelCatalog(configDir))) {
    if (index.has(provider)) continue;
    const models = readModelCatalog(configDir)[provider].models || {};
    rows.push({ id: provider, handler: null, count: Object.keys(models).length });
  }
  return rows;
}
