import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { readJson } from "./json.js";
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
const ORG_PAGE_LIMIT = 5;
const REFS = ["HEAD", "main", "master"];

// The category topics repo-meta assigns, exactly one per repository. A repo that declares topics but
// none of these is not a plugin repository, so its manifest is never fetched; a repo that declares no
// topics at all is always asked, because nothing has ruled it out. Topics only narrow WHO is asked:
// the answer always comes from the manifest, since one repo can provide several capabilities and a
// single category topic cannot say so.
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

async function fetchJsonDefault(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { "User-Agent": "core-loader" }, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** One repository a source offers, before its own manifest has been read. */
interface Candidate {
  owner: string;
  repo: string;
  url: string;
  description: string;
  topics: string[];
  archived: boolean;
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

async function orgCandidates(source: MarketplaceSource, deps: CatalogDeps): Promise<Candidate[]> {
  const fetchJson = deps.fetchJson ?? fetchJsonDefault;
  const org = String(source.org);
  const found: Candidate[] = [];
  for (let page = 1; page <= ORG_PAGE_LIMIT; page++) {
    const listed = await fetchJson(`https://api.github.com/orgs/${org}/repos?per_page=100&page=${page}`);
    if (!Array.isArray(listed) || listed.length === 0) break;
    for (const raw of listed) {
      const repo = raw as { name?: string; html_url?: string; description?: string; topics?: string[]; archived?: boolean };
      if (!repo.name) continue;
      found.push({
        owner: org,
        repo: repo.name,
        url: repo.html_url ? `${repo.html_url}.git` : `https://github.com/${org}/${repo.name}.git`,
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
    const entry = item as { url?: unknown; description?: unknown; topics?: unknown };
    const parsed = ownerRepoOf(entry?.url);
    if (!parsed) continue;
    found.push({
      owner: parsed.owner,
      repo: parsed.repo,
      url: String(entry.url),
      description: typeof entry.description === "string" ? entry.description : "",
      topics: Array.isArray(entry.topics) ? (entry.topics as unknown[]).filter((topic): topic is string => typeof topic === "string") : [],
      archived: false,
    });
  }
  return found;
}

async function candidatesOf(source: MarketplaceSource, deps: CatalogDeps): Promise<Candidate[]> {
  if (source.type === "github-org") return orgCandidates(source, deps);
  if (source.type === "manifest") {
    const fetchJson = deps.fetchJson ?? fetchJsonDefault;
    return listedCandidates(await fetchJson(String(source.url)));
  }
  const read = deps.readFileFn ?? ((file: string) => readFileSync(file, "utf8"));
  const base = String(source.path);
  const file = base.endsWith(".json") ? base : join(base, "marketplace.json");
  try {
    return listedCandidates(JSON.parse(read(file)));
  } catch {
    return [];
  }
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
  candidate: { url: string; description: string },
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
  return entry;
}

// Whichever ref answers first, matching the seed-marketplace fetch: a repository may have renamed its
// default branch, and a raw read costs nothing against an API budget.
async function firstRef(
  fetchJson: (url: string) => Promise<unknown>,
  owner: string,
  repo: string,
  file: string,
): Promise<unknown> {
  for (const ref of REFS) {
    const parsed = await fetchJson(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${file}`);
    if (parsed) return parsed;
  }
  return null;
}

async function readCandidate(candidate: Candidate, sourceId: string, deps: CatalogDeps): Promise<CatalogEntry | null> {
  const fetchJson = deps.fetchJson ?? fetchJsonDefault;
  const manifest = await firstRef(fetchJson, candidate.owner, candidate.repo, "plugin.json");
  if (!manifest) return null;
  const pkg = await firstRef(fetchJson, candidate.owner, candidate.repo, "package.json");
  return entryFrom(manifest, (pkg as { name?: unknown } | null)?.name, candidate, sourceId);
}

/**
 * Every entry the declared sources offer, read concurrently.
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
          const read = await Promise.all(candidates.map((candidate) => readCandidate(candidate, source.id, deps)));
          return read.filter((entry): entry is CatalogEntry => entry !== null);
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
  const cached = readJson(join(paths.cacheDir, CATALOG_CACHE_FILE));
  if (!cached || typeof cached !== "object" || !Array.isArray(cached.entries)) return null;
  if (now() - Number(cached.time || 0) > windowMs) return null;
  return cached.entries as CatalogEntry[];
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
 * Every entry providing a capability, from the cache while it is fresh.
 *
 * @remarks
 * The whole catalog is cached rather than one question's answer, and an EMPTY catalog is cached too:
 * a home where nothing provides a capability must not re-read every marketplace on every launch,
 * which is the difference between a cold start that costs nothing and one that costs a round trip.
 */
export async function queryCapability(
  capabilityId: string,
  sources: MarketplaceSource[],
  paths: HomePaths,
  windowMs: number,
  deps: CatalogDeps = {},
): Promise<CatalogEntry[]> {
  const now = deps.now ?? Date.now;
  let entries = cachedEntries(paths, windowMs, now);
  if (!entries) {
    entries = await readCatalog(sources, deps);
    writeCache(paths, entries, now);
  }
  return entries.filter((entry) => Array.isArray(entry.capabilities) && entry.capabilities.includes(capabilityId));
}
