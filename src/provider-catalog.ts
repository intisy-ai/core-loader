// @ts-nocheck
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

// The pre-rename file is still read so a home that has not refreshed since keeps its catalog.
const CATALOG_FILES = ["models.json", "core-auth-models.json"];

export function readModelCatalog(configDir) {
  for (const file of CATALOG_FILES) {
    const at = join(configDir, "config", file);
    if (!existsSync(at)) continue;
    const parsed = readJson(at);
    // Anything that is not a map of providers is as useless as no catalog, and returning it
    // would have every caller guess at the shape instead.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  }
  return {};
}

// Every provider deployed here, deduplicated: a plugin can declare several (one per upstream
// lane) and can add more at runtime through its dynamic manifest.
export function deployedProviders(reposDir) {
  const out = [];
  const seen = new Set();
  for (const entry of readDeployedProviders(reposDir)) {
    if (seen.has(entry.provider)) continue;
    seen.add(entry.provider);
    out.push(entry);
  }
  return out;
}

// One row per model, across every provider. A provider's live catalog wins; a provider that
// ships a static list and fetches nothing falls back to that.
export function modelEntries(reposDir, configDir) {
  const catalog = readModelCatalog(configDir);
  const out = [];
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
    for (const declared of entry.models || []) {
      const model = typeof declared === "string" ? declared : declared.id;
      const name = typeof declared === "string" ? declared : (declared.name || declared.id);
      out.push({ provider, model, name, id: provider + "/" + model });
    }
  }
  return out;
}

// Every provider a loader should list, with the models it serves. A provider with none is
// still listed and still selectable: antigravity has no catalog until someone logs in, and
// hiding it would leave no way to log in.
//
// A provider with a cached catalog but nothing deployed is listed too, with no handler, so a
// leftover shows rather than silently disappearing along with the plugin that served it.
export function providerRows(reposDir, configDir) {
  const rows = [];
  const index = new Map();
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
