import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { readJson } from "./json.js";
import { MARKETPLACE_MANIFEST_PATH } from "./catalogs.js";
import type { HomePaths } from "./home-paths.js";
import type { MarketplaceSource } from "./catalog-sources.js";

/** One repository a marketplace offers, as its own manifest describes it. */
export interface CatalogEntry {
  /** The id its `plugin.json` declares, which is also its deployed bundle and sidecar basename. */
  id: string;
  /** Its npm package name, from its `package.json`, falling back to its id. */
  npmName: string;
  /** Its clone URL. */
  url: string;
  /** Every capability its manifest declares, so one read answers every capability question. */
  capabilities: string[];
  /** Its own one-line description, for a marketplace row. */
  description: string;
  /** The name a surface shows instead of the id. */
  displayName?: string;
  /**
   * The display category its source declared, which nothing derives.
   *
   * @remarks
   * A curated category ("memory", "statusline", "browser") is editorial: no scan of a repository
   * produces it, and no third-party marketplace file carries one. A source that has an opinion says
   * so per entry; everything else falls back to what the entry itself declares.
   */
  category?: string;
  /** The declared source that offered it. */
  sourceId: string;
}

/** Everything this module reaches the outside world through, so a test can supply all of it. */
export interface CatalogDeps {
  /** Fetches and parses one JSON document, answering null on any failure. */
  fetchJson?: (url: string) => Promise<unknown>;
  /** Reads one local file, throwing when it is absent. */
  readFileFn?: (file: string) => string;
  /** The current time, for the cache window. */
  now?: () => number;
  /** Diagnostic sink. The TUI passes its file logger, because anything printed corrupts the screen. */
  log?: (message: string) => void;
}

/** The cache file, beside the marketplace and seed caches. */
export const CATALOG_CACHE_FILE = "capability-catalog.json";

const FETCH_TIMEOUT_MS = 15000;
const OWNER_PAGE_LIMIT = 5;
const REFS = ["HEAD", "main", "master"];

/** Which GitHub listing an owner login is asked for, in the order they are tried. */
type OwnerScope = "orgs" | "users";

const OWNER_SCOPES: OwnerScope[] = ["orgs", "users"];

/** What a third-party marketplace file offers, since its own schema calls every item a plugin. */
const THIRD_PARTY_CATEGORY = "Plugin";

/**
 * The category topics repo-meta assigns, exactly one per repository.
 *
 * @remarks
 * A repo that declares topics but none of these is not a plugin repository, so its manifest is never
 * fetched; a repo that declares no topics at all is always asked, because nothing has ruled it out.
 * Topics only narrow WHO is asked: the answer always comes from the manifest, since one repo can
 * provide several capabilities and a single category topic cannot say so.
 */
const CATEGORY_TOPICS = [
  "core-library",
  "app-proxy",
  "vendor-translator",
  "ai-provider",
  "app-loader",
  "plugin",
  "tool",
  "dashboard",
  "runtime",
];

async function fetchJsonDefault(url: string, log: (message: string) => void): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { "User-Agent": "core-loader" }, signal: controller.signal });
    if (!response.ok) {
      log(`fetch ${url} answered ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    log(`fetch ${url} failed: ${String(error)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The fetch a caller's own `deps.fetchJson` bypasses entirely, so an injected fetch is exactly the
 * function a test supplied and never gains logging or network access it did not ask for.
 */
function resolveFetchJson(deps: CatalogDeps): (url: string) => Promise<unknown> {
  if (deps.fetchJson) return deps.fetchJson;
  const log = deps.log ?? (() => {});
  return (url: string) => fetchJsonDefault(url, log);
}

/** One repository a source offers, before its own manifest has been read. */
interface Candidate {
  owner: string;
  repo: string;
  url: string;
  description: string;
  topics: string[];
  archived: boolean;
  category?: string;
}

/** Whether a candidate's topics leave it a possible plugin repository. */
export function isPluginCandidate(candidate: { topics: string[]; archived: boolean }): boolean {
  if (candidate.archived) return false;
  if (candidate.topics.length === 0) return true;
  return candidate.topics.some((topic) => CATEGORY_TOPICS.includes(topic));
}

function ownerRepoOf(url: unknown): { owner: string; repo: string } | null {
  const match = String(url || "").match(/github\.com[/:]([^/]+)\/([^/]+?)(\.git)?$/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

function repoPage(scope: OwnerScope, owner: string, page: number): string {
  return `https://api.github.com/${scope}/${owner}/repos?per_page=100&page=${page}`;
}

/**
 * The listing scope a GitHub owner answers under, resolved from the first page that returns
 * repositories.
 *
 * @remarks
 * `/orgs/<login>` answers 404 for a personal account, so an owner-scoped source that only ever asked
 * for an organisation returned nothing at all for a user, silently. The scope is resolved once and
 * reused for every later page, so a personal account costs one extra request in total and an
 * organisation costs none.
 */
async function resolveOwnerScope(
  fetchJson: (url: string) => Promise<unknown>,
  owner: string,
): Promise<{ scope: OwnerScope; first: unknown[] } | null> {
  for (const scope of OWNER_SCOPES) {
    const listed = await fetchJson(repoPage(scope, owner, 1));
    if (Array.isArray(listed) && listed.length > 0) return { scope, first: listed };
  }
  return null;
}

async function ownerCandidates(source: MarketplaceSource, deps: CatalogDeps): Promise<Candidate[]> {
  const fetchJson = resolveFetchJson(deps);
  const owner = String(source.org);
  const resolved = await resolveOwnerScope(fetchJson, owner);
  if (!resolved) return [];
  const found: Candidate[] = [];
  let listed: unknown[] = resolved.first;
  for (let page = 1; page <= OWNER_PAGE_LIMIT; page++) {
    if (page > 1) {
      const next = await fetchJson(repoPage(resolved.scope, owner, page));
      if (!Array.isArray(next) || next.length === 0) break;
      listed = next;
    }
    for (const raw of listed) {
      const repo = raw as { name?: string; html_url?: string; description?: string; topics?: string[]; archived?: boolean };
      if (!repo.name) continue;
      found.push({
        owner,
        repo: repo.name,
        url: repo.html_url ? `${repo.html_url}.git` : `https://github.com/${owner}/${repo.name}.git`,
        description: repo.description || "",
        topics: Array.isArray(repo.topics) ? repo.topics : [],
        archived: repo.archived === true,
      });
    }
    if (listed.length < 100) break;
  }
  return found;
}

function listedCandidates(raw: unknown): Candidate[] {
  const listed = (raw as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(listed)) return [];
  const found: Candidate[] = [];
  for (const item of listed) {
    const entry = item as { url?: unknown; description?: unknown; topics?: unknown; category?: unknown };
    const parsed = ownerRepoOf(entry?.url);
    if (!parsed) continue;
    const candidate: Candidate = {
      owner: parsed.owner,
      repo: parsed.repo,
      url: String(entry.url),
      description: typeof entry.description === "string" ? entry.description : "",
      topics: Array.isArray(entry.topics) ? (entry.topics as unknown[]).filter((topic): topic is string => typeof topic === "string") : [],
      archived: false,
    };
    if (typeof entry.category === "string" && entry.category) candidate.category = entry.category;
    found.push(candidate);
  }
  return found;
}

async function candidatesOf(source: MarketplaceSource, deps: CatalogDeps): Promise<Candidate[]> {
  if (source.type === "github-org") return ownerCandidates(source, deps);
  if (source.type === "manifest") {
    const fetchJson = resolveFetchJson(deps);
    return listedCandidates(await fetchJson(String(source.url)));
  }
  const read = deps.readFileFn ?? ((file: string) => readFileSync(file, "utf8"));
  const base = String(source.path);
  const file = base.endsWith(".json") ? base : join(base, "marketplace.json");
  return listedCandidates(JSON.parse(read(file)));
}

/**
 * One candidate's own manifest as a catalog entry, or null when it declares no usable manifest.
 *
 * @remarks
 * A repository with no capabilities is still an entry: a library is a real thing a marketplace
 * offers, and a capability query simply never matches it.
 */
export function entryFrom(
  manifest: unknown,
  packageName: unknown,
  candidate: { url: string; description: string; category?: string },
  sourceId: string,
): CatalogEntry | null {
  if (!manifest || typeof manifest !== "object") return null;
  const declared = manifest as { id?: unknown; capabilities?: unknown; displayName?: unknown };
  if (typeof declared.id !== "string" || !declared.id) return null;
  const entry: CatalogEntry = {
    id: declared.id,
    npmName: typeof packageName === "string" && packageName ? packageName : declared.id,
    url: candidate.url,
    capabilities: Array.isArray(declared.capabilities)
      ? (declared.capabilities as unknown[]).filter((id): id is string => typeof id === "string" && id.length > 0)
      : [],
    description: candidate.description,
    sourceId,
  };
  if (typeof declared.displayName === "string" && declared.displayName) entry.displayName = declared.displayName;
  if (candidate.category) entry.category = candidate.category;
  return entry;
}

/**
 * The clone url one item of a third-party marketplace file installs from.
 *
 * @remarks
 * Its `source` is measured in three shapes: a relative path within the marketplace repository, an
 * object naming a url, and an object naming an `owner/repo`. A relative path is not a separate
 * repository, so the marketplace repository's own url is what a subdirectory plugin is cloned from.
 */
function marketplaceItemUrl(source: unknown, repoUrl: string): string {
  if (!source || typeof source !== "object") return repoUrl;
  const declared = source as { url?: unknown; repo?: unknown };
  if (typeof declared.url === "string" && declared.url) return declared.url;
  if (typeof declared.repo === "string" && declared.repo) return `https://github.com/${declared.repo}.git`;
  return repoUrl;
}

/**
 * Every plugin a third-party marketplace file offers, as catalog entries.
 *
 * @remarks
 * One repository can offer several plugins, which is what this file shape exists to say, so a
 * candidate yields a list rather than a single entry. None of them declares a capability: a
 * capability query never matches a third-party plugin, and a marketplace row is the whole point of
 * reading it.
 */
export function entriesFromMarketplaceManifest(
  manifest: unknown,
  candidate: { url: string; description: string; category?: string },
  sourceId: string,
): CatalogEntry[] {
  const listed = (manifest as { plugins?: unknown } | null)?.plugins;
  if (!Array.isArray(listed)) return [];
  const found: CatalogEntry[] = [];
  for (const item of listed) {
    const declared = item as { name?: unknown; description?: unknown; source?: unknown };
    if (typeof declared?.name !== "string" || !declared.name) continue;
    found.push({
      id: declared.name,
      npmName: declared.name,
      url: marketplaceItemUrl(declared.source, candidate.url),
      capabilities: [],
      description: typeof declared.description === "string" && declared.description ? declared.description : candidate.description,
      category: candidate.category || THIRD_PARTY_CATEGORY,
      sourceId,
    });
  }
  return found;
}

/**
 * Whichever ref answers first, matching the seed-marketplace fetch.
 *
 * @remarks
 * A repository may have renamed its default branch, and a raw read costs nothing against an API
 * budget.
 */
async function firstRef(
  fetchJson: (url: string) => Promise<unknown>,
  owner: string,
  repo: string,
  file: string,
): Promise<unknown> {
  for (const ref of REFS) {
    const parsed = await fetchJson(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${file}`);
    if (parsed !== null && parsed !== undefined) return parsed;
  }
  return null;
}

/** How many candidates one source is read at a time. */
const CANDIDATE_BATCH = 8;

/**
 * Maps over items a batch at a time, keeping input order.
 *
 * @remarks
 * Each candidate costs up to three sequential raw reads, so an unbounded fan-out over a large
 * organisation issues hundreds of near-simultaneous requests and is throttled into failing, which
 * reads as an empty catalog rather than as a rate limit.
 */
async function inBatches<T, R>(items: T[], size: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    results.push(...(await Promise.all(items.slice(start, start + size).map(map))));
  }
  return results;
}

/**
 * Everything one candidate repository offers, by its own manifest.
 *
 * @remarks
 * `plugin.json` is asked for first because it is the richer shape: an id, the capabilities and a
 * display name. Only a repository that carries none is read as a third-party marketplace, so a
 * repository carrying both is described by its own manifest.
 */
async function readCandidate(candidate: Candidate, sourceId: string, deps: CatalogDeps): Promise<CatalogEntry[]> {
  const fetchJson = resolveFetchJson(deps);
  const manifest = await firstRef(fetchJson, candidate.owner, candidate.repo, "plugin.json");
  if (manifest) {
    const pkg = await firstRef(fetchJson, candidate.owner, candidate.repo, "package.json");
    const entry = entryFrom(manifest, (pkg as { name?: unknown } | null)?.name, candidate, sourceId);
    return entry ? [entry] : [];
  }
  const offered = await firstRef(fetchJson, candidate.owner, candidate.repo, MARKETPLACE_MANIFEST_PATH);
  return offered ? entriesFromMarketplaceManifest(offered, candidate, sourceId) : [];
}

/**
 * Every entry the declared sources offer, sources concurrently and their candidates in batches.
 *
 * @remarks
 * A source that throws contributes its reason to the log and nothing to the answer: one unreachable
 * marketplace must never read as an empty catalog. Config order is precedence, so the first source to
 * claim an id keeps it.
 */
export async function readCatalog(sources: MarketplaceSource[], deps: CatalogDeps = {}): Promise<CatalogEntry[]> {
  const log = deps.log ?? (() => {});
  const perSource = await Promise.all(
    sources
      .filter((source) => source.enabled !== false)
      .map(async (source) => {
        try {
          const candidates = (await candidatesOf(source, deps)).filter(isPluginCandidate);
          const read = await inBatches(candidates, CANDIDATE_BATCH, (candidate) => readCandidate(candidate, source.id, deps));
          return read.flat();
        } catch (error) {
          log(`marketplace source ${source.id} could not be read: ${String(error)}`);
          return [] as CatalogEntry[];
        }
      }),
  );
  const byId = new Map<string, CatalogEntry>();
  for (const entries of perSource) {
    for (const entry of entries) if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

/** Drops the cached catalog so the next query reads the sources again. */
export function invalidateCapabilityCatalog(paths: HomePaths): void {
  try {
    unlinkSync(join(paths.cacheDir, CATALOG_CACHE_FILE));
  } catch {
    // nothing cached
  }
}

function cachedEntries(paths: HomePaths, windowMs: number, now: () => number): CatalogEntry[] | null {
  const cached = readJson<{ time?: unknown; entries?: unknown }>(join(paths.cacheDir, CATALOG_CACHE_FILE));
  if (!cached || typeof cached !== "object" || !Array.isArray(cached.entries)) return null;
  if (now() - Number(cached.time || 0) > windowMs) return null;
  return (cached.entries as unknown[]).filter(
    (entry): entry is CatalogEntry => !!entry && typeof entry === "object",
  );
}

function writeCache(paths: HomePaths, entries: CatalogEntry[], now: () => number): void {
  try {
    if (!existsSync(paths.cacheDir)) mkdirSync(paths.cacheDir, { recursive: true });
    writeFileSync(join(paths.cacheDir, CATALOG_CACHE_FILE), JSON.stringify({ time: now(), entries }));
  } catch {
    // a home that cannot be written to still answers, it just answers from the network next time
  }
}

/**
 * Every entry the declared sources offer, from the cache while it is fresh.
 *
 * @remarks
 * The whole catalog is cached rather than one question's answer, and an EMPTY catalog is cached too:
 * a home where nothing provides a capability must not re-read every marketplace on every launch,
 * which is the difference between a cold start that costs nothing and one that costs a round trip.
 * Every reader goes through here, so freshness is decided in exactly one place.
 */
export async function catalogFor(
  sources: MarketplaceSource[],
  paths: HomePaths,
  windowMs: number,
  deps: CatalogDeps = {},
): Promise<CatalogEntry[]> {
  const now = deps.now ?? Date.now;
  const cached = cachedEntries(paths, windowMs, now);
  if (cached) return cached;
  const entries = await readCatalog(sources, deps);
  writeCache(paths, entries, now);
  return entries;
}

/** Every entry providing a capability. */
export async function queryCapability(
  capabilityId: string,
  sources: MarketplaceSource[],
  paths: HomePaths,
  windowMs: number,
  deps: CatalogDeps = {},
): Promise<CatalogEntry[]> {
  const entries = await catalogFor(sources, paths, windowMs, deps);
  return entries.filter((entry) => Array.isArray(entry.capabilities) && entry.capabilities.includes(capabilityId));
}

/**
 * The display category of an entry, derived from what it declares.
 *
 * @remarks
 * A category its source declared wins, because a curated one carries editorial judgement nothing
 * derives. Otherwise its first capability, title cased, because a marketplace groups by what a thing
 * IS and the first declared capability is the plugin author's own answer to that. A repository that
 * declares none is a library. Nothing here enumerates the capability vocabulary, so a capability
 * minted after this host shipped still groups under its own name rather than falling into an "other"
 * bucket.
 */
export function categoryOf(entry: CatalogEntry): string {
  if (typeof entry.category === "string" && entry.category) return entry.category;
  const first = Array.isArray(entry.capabilities) ? entry.capabilities.find((id) => typeof id === "string" && id) : undefined;
  if (!first) return "Library";
  return first.charAt(0).toUpperCase() + first.slice(1);
}
