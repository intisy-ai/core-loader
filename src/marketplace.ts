// Plugin marketplace: async catalog fetches (GitHub topics, npm, awesome list),
// on-disk catalog cache, list building, and one-shot plugin install via git.

import { existsSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { readJson } from "./json.js";
import { exec } from "child_process";
import { CATALOG_CACHE_PATH, CACHE_DIR, MCP_CATALOG, FEATURED_PLUGINS, APP_ID, DEFAULT_MARKETPLACES, SEED_CACHE_PATH, CONFIG_DIR, MARKETPLACE_MANIFEST_PATH, tuiLog } from "./env.js";
import { appDiscovery } from "./app-descriptor.js";
import { S } from "./state.js";
import { loadPlugins, catalogCacheHours, registerPlugin } from "./config.js";
import { scheduleRender } from "./views/common.js";
import { buildMcpList } from "./mcp.js";
import { setupPlugin } from "./updater.js";
import { homePaths } from "./home-paths.js";
import { readMarketplaceSources } from "./catalog-sources.js";
import { catalogFor, categoryOf } from "./capability-catalog.js";
import type { MarketplaceSource } from "./catalog-sources.js";
import type { CatalogEntry } from "./capability-catalog.js";
import type { McpCatalogEntry } from "./catalogs.js";
import type { ActionRow } from "./action-row.js";
import type { CapabilityMarketplace, CapabilityMarketplacePlugin } from "./app-capabilities.js";
import type { SeedMarketplace } from "./state.js";

/** The on-disk catalog cache: both lists, and when they were written. */
interface CatalogCacheFile {
  /** When it was written, in epoch milliseconds. */
  time: number;
  /** The plugin catalog. */
  marketplace: MarketplaceRow[];
  /** The MCP catalog. */
  mcp?: McpCatalogEntry[];
}

/** The on-disk seed cache: every seeded marketplace's fetched state, and when it was written. */
interface SeedCacheFile {
  /** When it was written, in epoch milliseconds. */
  time: number;
  /** Each seed's state, by name. */
  data: Record<string, SeedMarketplace>;
}

/** One repository as the GitHub search API describes it. */
interface GithubRepo {
  /** Its own name. */
  name: string;
  /** Its `owner/name`. */
  full_name: string;
  /** Its one-line description. */
  description?: string;
  /** Its star count. */
  stargazers_count?: number;
  /** Who owns it. */
  owner?: { login: string };
}

/**
 * One row of the marketplace browser, at either of its two levels.
 *
 * @remarks
 * Level 1 lists marketplaces, level 2 lists one marketplace's plugins, and the two synthetic "add"
 * rows sit at the top of level 1. All three land in the SAME array so `mkCursor` indexes straight
 * into it with no offset arithmetic anywhere, which is why the fields only one kind fills are
 * optional here.
 */
export interface MarketplaceRow {
  /** What the row is shown as. */
  name: string;
  /** Where the entry came from: a repo, a registry, or the phrase describing a built-in list. */
  source?: string;
  /** How many plugins a level-1 row offers, or `undefined` while that is still being fetched. */
  count?: number;
  /** Which built-in list this level-1 row is, when it is one. */
  builtin?: string;
  /** Whether the host app registered this marketplace rather than this home declaring it. */
  capability?: boolean;
  /** Whether this is a seeded default the home has not adopted. */
  seed?: boolean;
  /** The `owner/repo` a seed row installs from. */
  repo?: string;
  /** The declared source this row belongs to, which is how a level-2 list is narrowed. */
  sourceId?: string;
  /** Whether this row runs an action instead of opening something. */
  isAction?: boolean;
  /** Which action it runs. */
  actionKey?: string;
  /** One line about what the plugin does. */
  desc?: string;
  /** The same, under the key a fetched manifest uses. */
  description?: string;
  /** Where the plugin is cloned from. */
  url?: string;
  /** The plugin's repository name. */
  repoName?: string;
  /** The repository's `owner/name`. */
  full_name?: string;
  /** The GitHub account that owns it. */
  author?: string;
  /** The heading it is grouped under. */
  category?: string;
  /** Whether this home already has it. */
  installed?: boolean;
  /** Its GitHub star count, which is what the catalog is ranked by. */
  stars?: number;
  /** Whether it came from the curated standalone list rather than a search. */
  featured?: boolean;
  /** Whether it is a curated entry awaiting star enrichment. */
  curated?: boolean;
  /** The id the host app installs it by, for a capability marketplace's entry. */
  id?: string;
}

/** Drops the cached plugin and MCP catalogs, so the next open refetches them. */
export function invalidateCatalogCache() {
  try { unlinkSync(CATALOG_CACHE_PATH); } catch {}
}

/** Drops the cached seed manifests. */
export function invalidateSeedCache() {
  try { unlinkSync(SEED_CACHE_PATH); } catch {}
}

/**
 * A cached entry carrying a category nothing derives any more, brought onto the current vocabulary.
 *
 * @remarks
 * A cache written before the category came from an entry's own capabilities can still hold
 * "Official", and the renderer emits a heading on every category change, so a single stale value
 * interleaves headings down the whole list. The cache is the one place such a value enters.
 */
function withCurrentCategory(entry: MarketplaceRow): MarketplaceRow {
  if (entry && entry.category === "Official") entry.category = "Community";
  return entry;
}

/** Fills the catalogs from the on-disk cache, answering whether it was fresh enough to use. */
export function loadCatalogCache(): boolean {
  try {
    var cached = readJson<CatalogCacheFile>(CATALOG_CACHE_PATH);
    if (!cached || Date.now() - cached.time > catalogCacheHours() * 3600000) return false;
    if (!Array.isArray(cached.marketplace) || cached.marketplace.length === 0) return false;
    for (var ce of cached.marketplace) S.MARKETPLACE_CATALOG.push(withCurrentCategory(ce));
    for (var me of (cached.mcp || [])) {
      var existing = MCP_CATALOG.find(function(x) { return x.name === me.name; });
      // a pre-seeded curated entry stays in place but adopts the cached stars/repo
      // it was enriched with on a previous run (otherwise they'd re-fetch every open)
      if (!existing) MCP_CATALOG.push(me);
      else {
        if (existing.stars == null && me.stars != null) existing.stars = me.stars;
        if (!existing.full_name && me.full_name) existing.full_name = me.full_name;
      }
    }
    tuiLog("marketplace catalog loaded from cache");
    return true;
  } catch { return false; }
}

// ---- Seeded default marketplaces --------------------------------------
// DEFAULT_MARKETPLACES (env.ts) are popular marketplaces shown at Level 1 for
// every user, even before they've added them to the host app. Each seed's
// .claude-plugin/marketplace.json is fetched once per cache window (HEAD,
// falling back to main/master) and cached on disk exactly like the plugin
// catalog above, so a cold TUI open never blocks on the network. Level 1
// shows the seed immediately with count "…" until the fetch (kicked off at
// startup, see fetchSeedMarketplacesAsync below) resolves.

function loadSeedCache(): boolean {
  try {
    var cached = readJson<SeedCacheFile>(SEED_CACHE_PATH);
    if (!cached || Date.now() - cached.time > catalogCacheHours() * 3600000) return false;
    if (!cached.data || typeof cached.data !== "object") return false;
    for (var name in cached.data) S.seedMarketplaces[name] = cached.data[name];
    tuiLog("seed marketplaces loaded from cache");
    return true;
  } catch { return false; }
}

function saveSeedCache() {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(SEED_CACHE_PATH, JSON.stringify({ time: Date.now(), data: S.seedMarketplaces }));
    tuiLog("seed marketplaces cached (" + Object.keys(S.seedMarketplaces).length + ")");
  } catch {}
}

/**
 * A fetched marketplace.json's `plugins` array -> the drill-in shape used by
 * buildMarketplacePluginsList. [] on anything malformed (never throws).
 */
export function parseSeedPlugins(json: { plugins?: unknown } | null | undefined, seedName: string): MarketplaceRow[] {
  var plugins = json && json.plugins;
  if (!Array.isArray(plugins)) return [];
  return plugins.map(function(e: { name?: string; description?: string }): MarketplaceRow {
    return { id: (e && e.name) || "", name: (e && e.name) || "", description: (e && e.description) || "", source: seedName };
  });
}

/**
 * Async, non-blocking, cache-respecting: called (guarded by S.seedFetched) every
 * time Level 1 is built, same shape as fetchCatalogsAsync. On a fresh cache hit
 * this does nothing further; otherwise it fetches each seed once, trying HEAD
 * then main then master, and degrades a seed to count 0 / empty drill-in on
 * total failure (offline, renamed default branch, missing file, bad JSON);
 * it never throws and never blocks rendering.
 */
export function fetchSeedMarketplacesAsync() {
  if (S.seedFetched) return;
  S.seedFetched = true;
  if (loadSeedCache()) return;

  var curlCmd = process.platform === "win32" ? "curl.exe" : "curl";
  var branches = ["HEAD", "main", "master"];
  var remaining = DEFAULT_MARKETPLACES.length;

  function refreshIfViewing() {
    if (S.pluginSubPage === "marketplace") {
      S.marketplaceItems = buildMarketplaceList();
      scheduleRender();
    }
  }

  function seedSettled() {
    remaining--;
    refreshIfViewing();
    if (remaining <= 0) saveSeedCache();
  }

  function tryBranch(seed: { name: string; repo: string }, idx: number): void {
    if (idx >= branches.length) {
      S.seedMarketplaces[seed.name] = { plugins: [], count: 0, repo: seed.repo, error: "fetch failed" };
      seedSettled();
      return;
    }
    var url = "https://raw.githubusercontent.com/" + seed.repo + "/" + branches[idx] + "/" + MARKETPLACE_MANIFEST_PATH;
    S.catalogPending++;
    exec(curlCmd + ' -sL -H "User-Agent: intisy-ai-loader" "' + url + '"', { timeout: 15000 }, function(err, stdout) {
      S.catalogPending = Math.max(0, S.catalogPending - 1);
      if (!err && stdout) {
        try {
          var json = JSON.parse(stdout);
          if (json && Array.isArray(json.plugins)) {
            var plugins = parseSeedPlugins(json, seed.name);
            S.seedMarketplaces[seed.name] = { plugins: plugins, count: plugins.length, repo: seed.repo, error: null };
            seedSettled();
            return;
          }
        } catch (e) {}
      }
      tryBranch(seed, idx + 1);
    });
  }

  for (var si = 0; si < DEFAULT_MARKETPLACES.length; si++) tryBranch(DEFAULT_MARKETPLACES[si], 0);
}

/**
 * Reads what this home's declared marketplace sources offer, once per cache window.
 *
 * @remarks
 * Non-blocking and guarded by `S.sourceFetched`: Level 1 renders immediately with an unknown count
 * and fills in when this resolves. It reads through the on-disk catalog cache, so a warm home costs
 * no network at all, but that warm path resolves on the first microtask, before boot has picked the
 * tab to show, so the rebuild must not be conditional on the marketplace tab being the visible one.
 * `scheduleRender` is throttled, so rebuilding a list nobody is looking at costs nothing.
 * The success and failure handlers are separate arguments rather than a trailing `catch`, so a throw
 * from the rebuild cannot empty a catalog that was read successfully.
 */
export function fetchSourceCatalogAsync() {
  if (S.sourceFetched) return;
  S.sourceFetched = true;
  var paths = homePaths(CONFIG_DIR);
  catalogFor(readMarketplaceSources(paths), paths, catalogCacheHours() * 3600000, { log: tuiLog })
    .then(function (entries) {
      S.sourceCatalog = entries;
      S.marketplaceItems = buildMarketplaceList();
      scheduleRender();
    }, function (error) {
      S.sourceCatalog = [];
      tuiLog("declared marketplace sources could not be read: " + error);
    });
}

// Where a source reads from, which is what tells two rows apart when their labels are similar.
function describeSource(source: MarketplaceSource): string {
  if (source.type === "github-org") return "github: " + source.org;
  if (source.type === "manifest") return source.url || "";
  return source.path || "";
}

/**
 * One Level-1 row per enabled declared source, counted from the entries it offered.
 *
 * @remarks
 * `entries` is null until the read resolves, which is a different thing from a source that offered
 * nothing: the first renders as an unknown count, the second as zero.
 */
export function sourceRowsFrom(sources: MarketplaceSource[], entries: CatalogEntry[] | null | undefined): MarketplaceRow[] {
  var rows: MarketplaceRow[] = [];
  for (var i = 0; i < sources.length; i++) {
    var source = sources[i];
    if (source.enabled === false) continue;
    var count = entries === null || entries === undefined
      ? undefined
      : entries.filter(function (entry: CatalogEntry) { return entry.sourceId === source.id; }).length;
    rows.push({ name: source.label, source: describeSource(source), count: count, builtin: "source", sourceId: source.id });
  }
  return rows;
}

// The built-in verified list is seeded as the Curated section for any app that declares
// no curated list of its own: seed the VERIFIED FEATURED_PLUGINS repos as category
// "Curated", one hand-checked source of truth, no new unverified repos. full_name
// matching mirrors the GitHub-search dedupe further down this file; stars ride in via
// the existing enrichment passes.
function seedCuratedPlugins() {
  // an app with its own curated list does not need the built-in one seeded
  if (appDiscovery().awesomeList) return;
  for (var ci = 0; ci < FEATURED_PLUGINS.length; ci++) {
    var cur = FEATURED_PLUGINS[ci];
    var curKey = (cur.full_name || "").toLowerCase();
    var existingCur = S.MARKETPLACE_CATALOG.find(function(e) { return (e.full_name || "").toLowerCase() === curKey; });
    if (existingCur) {
      existingCur.category = "Curated";
      if (!existingCur.desc) existingCur.desc = cur.desc;
    } else {
      S.MARKETPLACE_CATALOG.push({ name: cur.name, desc: cur.desc, category: "Curated", author: cur.author, repoName: cur.repoName, full_name: cur.full_name, url: cur.url });
    }
  }
}

// catalog rows read better without the app's own prefix repeated on every name
function withoutAppPrefix(name: string): string {
  var text = String(name);
  var prefix = APP_ID ? APP_ID + "-" : "";
  return prefix && text.indexOf(prefix) === 0 ? text.slice(prefix.length) : text;
}

/** Starts the catalog fetches, once per session, and returns at once: every result lands through a redraw. */
export function fetchCatalogsAsync() {
  if (S.catalogFetched) return;
  S.catalogFetched = true;
  var curlCmd = process.platform === "win32" ? "curl.exe" : "curl";
  var discovery = appDiscovery();
  // even with a warm cache the curated MCP entries still need their stars derived
  // (the cache predates them); run that enrichment, then skip the cold registry search
  if (loadCatalogCache()) { seedCuratedPlugins(); enrichCuratedMcpStars(); return; }

  var enrichedOnce = false;

  // seed curated entries immediately so they appear even before remote fetches finish
  seedCuratedPlugins();

  function saveCatalog() {
    try {
      if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(CATALOG_CACHE_PATH, JSON.stringify({ time: Date.now(), marketplace: S.MARKETPLACE_CATALOG, mcp: MCP_CATALOG }));
      tuiLog("marketplace catalog cached (" + S.MARKETPLACE_CATALOG.length + " plugins)");
    } catch {}
  }

  // search-API star matching breaks on renamed repos and rate limits; per-repo
  // lookups use the larger core API budget and follow renames, then the result
  // is cached on disk so the budget is spent once, not per TUI open
  function enrichCuratedStars() {
    var missing = S.MARKETPLACE_CATALOG.filter(function(e) { return e.stars == null && e.full_name; }).slice(0, 40);
    tuiLog("enriching stars for " + missing.length + " catalog entries");
    for (var entry of missing) {
      (function(target) {
        S.catalogPending++;
        exec(curlCmd + ' -sL -H "User-Agent: intisy-ai-loader" "https://api.github.com/repos/' + target.full_name + '"', function(err, stdout) {
          if (!err && stdout) {
            try {
              var repo = JSON.parse(stdout);
              if (repo && typeof repo.stargazers_count === "number") {
                target.stars = repo.stargazers_count;
                if (!target.desc && repo.description) target.desc = repo.description;
              } else if (repo && repo.message) {
                tuiLog("github repos api (" + target.full_name + "): " + repo.message);
              }
            } catch {}
          }
          refreshMarketplace();
          fetchDone();
        });
      })(entry);
    }
  }

  function fetchDone() {
    S.catalogPending = Math.max(0, S.catalogPending - 1);
    if (S.catalogPending > 0) return;
    scheduleRender();
    if (!enrichedOnce) {
      enrichedOnce = true;
      enrichCuratedStars();
      if (S.catalogPending > 0) return;
    }
    saveCatalog();
  }
  // the curated MCP entries have no full_name/stars; derive a repo from their
  // npm package (registry .repository.url), fetch stars once per unique repo,
  // and apply to every entry sharing it. uvx entries are python, no npm -> skip.
  function npmPkgFromArgs(args: string[] | undefined): string | null {
    for (var i = 0; i < (args || []).length; i++) {
      var a = (args || [])[i];
      if (a.charAt(0) === "-") continue;                 // flags like -y, --db-path
      if (a.indexOf("/") !== -1 && a.charAt(0) !== "@") continue; // urls / paths
      if (a.indexOf("://") !== -1) continue;
      if (a.charAt(0) === "." || a.charAt(0) === "@" || /^[a-z0-9]/i.test(a)) {
        if (a === ".") continue;
        return a.replace(/@latest$/, "").replace(/@[\d^~].*$/, "");
      }
    }
    return null;
  }
  function repoFromNpmUrl(url: string | undefined): string | null {
    if (!url) return null;
    var clean = url.replace(/^git\+/, "").replace(/^git:\/\//, "https://");
    var m = clean.match(/github\.com[\/:]([^\/]+)\/([^\/]+?)(\.git)?$/);
    return m ? m[1] + "/" + m[2] : null;
  }
  function enrichCuratedMcpStars() {
    var pending = MCP_CATALOG.filter(function(e) {
      return e.curated && e.stars == null && e.command !== "uvx";
    });
    var repoToEntries: Record<string, McpCatalogEntry[]> = {};   // unique repo -> entries waiting on its stars
    function applyStars(fullName: string, stars: number): void {
      var list = repoToEntries[fullName] || [];
      for (var k = 0; k < list.length; k++) {
        list[k].full_name = fullName;
        if (typeof stars === "number") list[k].stars = stars;
      }
    }
    function fetchRepoStars(fullName: string): void {
      S.catalogPending++;
      exec(curlCmd + ' -sL -H "User-Agent: intisy-ai-loader" "https://api.github.com/repos/' + fullName + '"', function(err, stdout) {
        if (!err && stdout) {
          try {
            var repo = JSON.parse(stdout);
            if (repo && typeof repo.stargazers_count === "number") { applyStars(fullName, repo.stargazers_count); saveCatalog(); }
            else if (repo && repo.message) tuiLog("github repos api (" + fullName + "): " + repo.message);
          } catch {}
        }
        refreshMcp();
        fetchDone();
      });
    }
    function queueRepo(target: McpCatalogEntry, fullName: string): void {
      var first = !repoToEntries[fullName];
      if (first) repoToEntries[fullName] = [];
      repoToEntries[fullName].push(target);
      target.full_name = fullName;
      if (first) fetchRepoStars(fullName);   // dedupe: only the first entry triggers the repo lookup
    }
    // entries with a pre-seeded repo (env.ts CURATED_MCP_REPOS) skip npm entirely;
    // the official @modelcontextprotocol/server-* packages have no resolvable repo
    for (var entry of pending) {
      if (entry.full_name) queueRepo(entry, entry.full_name);
    }
    // the rest: resolve a repo from the npm package's repository field, then fetch
    for (var entry2 of pending) {
      if (entry2.full_name) continue;
      (function(target) {
        var pkg = npmPkgFromArgs(target.args);
        if (!pkg) return;
        S.catalogPending++;
        exec(curlCmd + ' -sL -H "User-Agent: intisy-ai-loader" "https://registry.npmjs.org/' + pkg + '"', function(err, stdout) {
          fetchDone();
          if (err || !stdout) return;
          try {
            var meta = JSON.parse(stdout);
            var fullName = repoFromNpmUrl(meta && meta.repository && meta.repository.url);
            if (fullName) queueRepo(target, fullName);
          } catch {}
        });
      })(entry2);
    }
  }

  function refreshMcp() {
    if (S.page === "mcp" && S.mcpSubPage === "marketplace") {
      S.mcpItems = buildMcpList("All");
      scheduleRender();
    }
  }

  function searchGH(query: string, catalog: MarketplaceRow[] | McpCatalogEntry[], pageNum: number): void {
    S.catalogPending++;
    exec(curlCmd + ' -s -H "User-Agent: intisy-ai-loader" "https://api.github.com/search/repositories?q=' + query + '&sort=stars&order=desc&per_page=100&page=' + pageNum + '"', function(err, stdout) {
      fetchDone();
      if (!err && stdout) {
        try {
          var json = JSON.parse(stdout);
          if (json.message) tuiLog("github search: " + json.message);
          if (json.items) {
            for (var i = 0; i < json.items.length; i++) {
              var it = json.items[i];
              var cleanName = withoutAppPrefix(it.name);
              // Match plugins by full_name (owner/repo), never by the stripped display
              // name: two different repos can strip to the same name, so a name match
              // writes one repo's star count onto the other.
              var exists = (catalog as Array<MarketplaceRow | McpCatalogEntry>).find(function(m) { return catalog === S.MARKETPLACE_CATALOG ? (!!(m as MarketplaceRow).full_name && (m as MarketplaceRow).full_name === it.full_name) : (m.name === it.name); });
              if (!exists) {
                if (catalog === S.MARKETPLACE_CATALOG) {
                  (catalog as MarketplaceRow[]).push({
                    name: cleanName,
                    desc: it.description || "",
                    category: "Community",
                    stars: it.stargazers_count,
                    author: it.owner ? it.owner.login : "",
                    repoName: it.name,
                    full_name: it.full_name,
                    url: "https://github.com/" + it.full_name + ".git",
                  });
                } else {
                  (catalog as McpCatalogEntry[]).push({
                    name: it.name,
                    desc: it.description || "",
                    category: "Community",
                    stars: it.stargazers_count,
                    command: "npx",
                    args: ["-y", it.full_name],
                    env: {},
                  });
                }
              } else {
                exists.stars = it.stargazers_count;
              }
            }
            (catalog as Array<MarketplaceRow | McpCatalogEntry>).sort(function(a, b) { return (b.stars || 0) - (a.stars || 0); });
            if (catalog === S.MARKETPLACE_CATALOG && S.pluginSubPage === "marketplace") {
               S.marketplaceItems = buildMarketplaceList();
               scheduleRender();
            } else if (catalog === MCP_CATALOG && S.page === "mcp" && S.mcpSubPage === "marketplace") {
               S.mcpItems = buildMcpList("All");
               scheduleRender();
            }
          }
        } catch(e) {}
      }
    });
  }

  function searchNpm(keyword: string): void {
    S.catalogPending++;
    exec(curlCmd + ' -s "https://registry.npmjs.org/-/v1/search?text=keywords:' + keyword + '&size=100"', function(err, stdout) {
      fetchDone();
      if (err || !stdout) return;
      try {
        var json = JSON.parse(stdout);
        for (var obj of (json.objects || [])) {
          var pkg = obj.package || {};
          var repoUrl = ((pkg.links && pkg.links.repository) || "").replace(/^git\+/, "");
          if (!repoUrl) continue;
          var repoMatch = repoUrl.match(/([^\/]+)\/([^\/]+?)(\.git)?$/);
          if (!repoMatch) continue;
          var author = repoMatch[1];
          var repoName = repoMatch[2];
          var shortName = pkg.name.replace(/^@[^\/]+\//, "");
          var exists = S.MARKETPLACE_CATALOG.find(function(e) {
            return e.name === shortName || (e.repoName || e.name) === repoName;
          });
          if (exists) continue;
          S.MARKETPLACE_CATALOG.push({
            name: shortName,
            desc: pkg.description || "",
            category: "Community",
            author: author,
            repoName: repoName,
            full_name: author + "/" + repoName,
            url: repoUrl.endsWith(".git") ? repoUrl : repoUrl + ".git",
          });
        }
        S.MARKETPLACE_CATALOG.sort(function(a, b) { return (b.stars || 0) - (a.stars || 0); });
        if (S.pluginSubPage === "marketplace") {
          S.marketplaceItems = buildMarketplaceList();
          scheduleRender();
        }
      } catch(e) {}
    });
  }

  // the declared awesome list is the curated membership oracle: the fuzzy
  // starred search may only contribute repos that the community list contains,
  // which keeps popular plugins in and look-alike repos out
  var awesomeSet: Record<string, boolean> | null = null;
  function refreshMarketplace() {
    S.MARKETPLACE_CATALOG.sort(function(a, b) { return (b.stars || 0) - (a.stars || 0); });
    if (S.pluginSubPage === "marketplace") {
      S.marketplaceItems = buildMarketplaceList();
      scheduleRender();
    }
  }

  function catalogHas(fullName: string): MarketplaceRow | undefined {
    var key = fullName.toLowerCase();
    return S.MARKETPLACE_CATALOG.find(function(e) { return (e.full_name || "").toLowerCase() === key; });
  }

  function searchPopular(query: string, pageNum: number): void {
    S.catalogPending++;
    exec(curlCmd + ' -s -H "User-Agent: intisy-ai-loader" "https://api.github.com/search/repositories?q=' + query + '&sort=stars&order=desc&per_page=100&page=' + pageNum + '"', function(err, stdout) {
      fetchDone();
      if (err || !stdout) return;
      try {
        var json = JSON.parse(stdout);
        if (json.message) tuiLog("github search: " + json.message);
        for (var it of (json.items || [])) {
          var existing = catalogHas(it.full_name || "");
          if (existing) {
            existing.stars = it.stargazers_count;
            if (!existing.desc) existing.desc = it.description || "";
            continue;
          }
          if (!awesomeSet || !awesomeSet[(it.full_name || "").toLowerCase()]) continue;
          S.MARKETPLACE_CATALOG.push({
            name: it.name, desc: it.description || "", category: "Community",
            stars: it.stargazers_count, author: it.owner.login, repoName: it.name,
            full_name: it.full_name, url: "https://github.com/" + it.full_name + ".git",
          });
        }
        refreshMarketplace();
      } catch(e) {}
    });
  }

  function fetchAwesomeList(url: string): void {
    S.catalogPending++;
    exec(curlCmd + ' -s "' + url + '"', { maxBuffer: 4 * 1024 * 1024 }, function(err, stdout) {
      fetchDone();
      if (!err && stdout) {
        try {
          var section = stdout;
          var pStart = stdout.indexOf("PLUGINS</strong>");
          var pEnd = stdout.indexOf("THEMES</strong>");
          if (pStart !== -1 && pEnd > pStart) section = stdout.substring(pStart, pEnd);
          awesomeSet = {};
          var badgeRe = /badgen\.net\/github\/stars\/([^"\/\s]+)\/([^"\/\s]+)/g;
          var m;
          while ((m = badgeRe.exec(section))) {
            var author = m[1];
            var repoName = m[2];
            awesomeSet[(author + "/" + repoName).toLowerCase()] = true;
            if (catalogHas(author + "/" + repoName)) continue;
            var descMatch = section.substring(m.index, m.index + 400).match(/<i>([^<]*)<\/i>/);
            S.MARKETPLACE_CATALOG.push({
              name: repoName, desc: descMatch ? descMatch[1] : "", category: "Curated",
              author: author, repoName: repoName, full_name: author + "/" + repoName,
              url: "https://github.com/" + author + "/" + repoName + ".git",
            });
          }
          refreshMarketplace();
        } catch(e) {}
      }
      // the broad starred search supplies star counts for the curated entries,
      // whose badge images carry no numbers; membership keeps it precise, and it
      // only runs at all for an app that declares a search query to broaden with
      if (discovery.searchQuery) {
        searchPopular(discovery.searchQuery, 1);
        searchPopular(discovery.searchQuery, 2);
      }
    });
  }

  if (discovery.topic) {
    searchGH("topic:" + discovery.topic, S.MARKETPLACE_CATALOG, 1);
    searchGH("topic:" + discovery.topic, S.MARKETPLACE_CATALOG, 2);
    searchNpm(discovery.topic);
  }
  // searchQuery only ever fires from inside fetchAwesomeList: without the list's membership filter, a broad search would widen the catalog with lookalike repos
  if (discovery.awesomeList) fetchAwesomeList(discovery.awesomeList);
  searchGH("topic:mcp-server", MCP_CATALOG, 1);
  searchGH("topic:mcp-server", MCP_CATALOG, 2);
  enrichCuratedMcpStars();
}

// Synthetic leading rows for the two universal "add" actions. They are prepended
// to the S.marketplaceItems array itself (not a parallel list) so S.mkCursor keeps
// indexing straight into one flat array, no separate offset math anywhere else.
// "add_plugin_url" always installs via the updater (every app); "add_marketplace"
// only appears once the active loader's extension registers S.capabilities.addMarketplace.
// Both are LEVEL-1-ONLY (they add a marketplace/plugin globally, not "into" a
// drilled-in marketplace), so only buildMarketplaceMarketsList() calls this.
function buildMarketplaceActionRows(): MarketplaceRow[] {
  var rows: MarketplaceRow[] = [{ isAction: true, actionKey: "add_plugin_url", name: "＋ Add plugin (git URL)" }];
  var addMk = S.capabilities && S.capabilities.addMarketplace;
  if (typeof addMk === "function") {
    rows.push({ isAction: true, actionKey: "add_marketplace", name: "＋ Add marketplace" });
  }
  return rows;
}

// The two Level-1 rows that are not a declared source: the catalog this file fetches by searching
// GitHub, npm and the awesome list, and the curated standalone list. Both are backed by data this
// file owns rather than by a marketplace anyone declared.
function loaderOwnMarketplaces(): MarketplaceRow[] {
  return [
    { name: "community", source: "built-in catalog", count: S.MARKETPLACE_CATALOG.length, builtin: "community" },
    { name: "Featured", source: "curated standalone plugins", count: FEATURED_PLUGINS.length, builtin: "featured" },
  ];
}

// Seeded defaults not already covered by a real (loader-own or capability)
// marketplace, matched by name (seenNames) or by the seed's repo appearing in
// a capability marketplace's `source` (git URL or "owner/repo"; seenRepos holds
// those sources lowercased). A seed the user already has wins, so it's never
// shown twice. Count is "…" (undefined) until fetchSeedMarketplacesAsync resolves.
function seedMarketplaceRows(seenNames: Record<string, boolean>, seenRepos: Record<string, boolean>): MarketplaceRow[] {
  var rows: MarketplaceRow[] = [];
  for (var i = 0; i < DEFAULT_MARKETPLACES.length; i++) {
    var seed = DEFAULT_MARKETPLACES[i];
    if (seenNames[seed.name]) continue;
    var repoKey = seed.repo.toLowerCase();
    var dup = false;
    for (var rk in seenRepos) { if (rk.indexOf(repoKey) !== -1) { dup = true; break; } }
    if (dup) continue;
    var cached = S.seedMarketplaces[seed.name];
    rows.push({
      name: seed.name,
      source: seed.repo,
      count: cached ? cached.count : undefined,
      seed: true,
      repo: seed.repo,
    });
  }
  return rows;
}

/**
 * Level 1: the marketplace-of-marketplaces list. Unified Add rows up top, then every source this
 * home declares, then the loader's own built-in catalog and curated list, then every marketplace
 * the active app's extension registers via capabilities.marketplaces(), deduped by name (an
 * earlier entry always wins a name collision), then the seeded defaults not already covered by a
 * real entry.
 */
export function buildMarketplaceMarketsList(): MarketplaceRow[] {
  fetchCatalogsAsync();
  fetchSeedMarketplacesAsync();
  fetchSourceCatalogAsync();
  var seen: Record<string, boolean> = {};
  var seenRepos: Record<string, boolean> = {};
  var rows = buildMarketplaceActionRows();
  // Declared sources first: they are what this home actually asked for, and the built-in catalog is a
  // fallback rather than the headline.
  var declared = sourceRowsFrom(readMarketplaceSources(homePaths(CONFIG_DIR)), S.sourceCatalog);
  for (var di = 0; di < declared.length; di++) { rows.push(declared[di]); seen[declared[di].name] = true; }
  var own = loaderOwnMarketplaces();
  for (var oi = 0; oi < own.length; oi++) { if (seen[own[oi].name]) continue; rows.push(own[oi]); seen[own[oi].name] = true; }
  var mfn = S.capabilities && S.capabilities.marketplaces;
  if (typeof mfn === "function") {
    var caps: CapabilityMarketplace[] = [];
    try { caps = mfn() || []; } catch (e) {}
    for (var ci = 0; ci < caps.length; ci++) {
      var c = caps[ci];
      if (!c || !c.name || seen[c.name]) continue;
      seen[c.name] = true;
      if (c.source) seenRepos[String(c.source).toLowerCase()] = true;
      rows.push({ name: c.name, source: c.source || "", count: typeof c.count === "number" ? c.count : 0, capability: true });
    }
  }
  var seeds = seedMarketplaceRows(seen, seenRepos);
  for (var sj = 0; sj < seeds.length; sj++) { rows.push(seeds[sj]); seen[seeds[sj].name] = true; }
  // action rows are UI chrome, not search results, keep them pinned regardless
  // of the active filter, same rule buildMarketplacePluginsList follows at Level 2.
  if (S.inputBuf) {
    var q = S.inputBuf.toLowerCase();
    rows = rows.filter(function(r) { return r.isAction || (r.name || "").toLowerCase().indexOf(q) !== -1; });
  }
  return rows;
}

/**
 * Level 2: a single marketplace's plugins, routed by kind. A declared source's entries come from its
 * own manifests (S.sourceCatalog), grouped by the category each entry's capabilities imply. The
 * built-in community catalog is served from the loader's own fetched catalog (S.MARKETPLACE_CATALOG,
 * which already carries a "Community"/"Curated" category on some entries). The curated Featured list
 * is served from the static FEATURED_PLUGINS list (env.ts). A seed is served from S.seedMarketplaces.
 * Anything else is assumed to be an app-registered capability marketplace, served through
 * capabilities.marketplacePlugins(name), which returns [] if the capability is absent or the
 * marketplace is unknown, so this degrades to an empty list rather than throwing.
 */
export function buildMarketplacePluginsList(marketName: string, marketKind?: string | null, sourceId?: string | null): MarketplaceRow[] {
  fetchCatalogsAsync();
  // Route by the KIND captured off the Level-1 row (builtin "community"/"featured" tag, "source",
  // or "capability"), not by string-comparing marketName against the loader's own display names: a
  // capability marketplace could itself be named "community" and would otherwise be
  // misrouted/dedup-swallowed into the built-in catalog. marketKind is undefined for any caller
  // that predates this param (defensive fallback to the old name comparison).
  var kind = marketKind || (marketName === "community" ? "community" : null);
  // A declared source's own entries, from its manifests rather than from a search. Each row carries
  // the same name/desc/url/repoName shape the built-in catalog rows do, so the install path and the
  // action menu treat it identically.
  if (kind === "source") {
    var declaredEntries = S.sourceCatalog || [];
    var installedHere = loadPlugins().map(function (p) { return p.name; });
    var resSrc = declaredEntries
      .filter(function (e) { return e.sourceId === sourceId; })
      .map(function (e: CatalogEntry): MarketplaceRow {
        var fullName = (e.url || "").replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
        // The clone name, which is what an install lands under: a marketplace repo can offer several
        // plugins out of one repository, so its entry id is not always its directory name.
        var repoName = fullName.split("/").pop() || e.id;
        return {
          name: e.id,
          desc: e.description,
          url: e.url,
          repoName: repoName,
          full_name: fullName,
          category: categoryOf(e),
          sourceId: e.sourceId,
          installed: installedHere.indexOf(e.id) !== -1 || installedHere.indexOf(repoName) !== -1,
        };
      });
    if (S.inputBuf) {
      var qSrc = S.inputBuf.toLowerCase();
      resSrc = resSrc.filter(function (m) { return (m.name || "").toLowerCase().indexOf(qSrc) !== -1 || (m.desc || "").toLowerCase().indexOf(qSrc) !== -1; });
    }
    // Sections must be CONTIGUOUS, because the renderer emits a heading on every category change.
    resSrc.sort(function (a, b) { return (a.category || "").localeCompare(b.category || "") || (a.name || "").localeCompare(b.name || ""); });
    return resSrc;
  }
  if (kind === "community") {
    var installed = loadPlugins();
    var installedNames = installed.map(function(p) { return p.name; });
    var res = S.MARKETPLACE_CATALOG.map(function(m) {
      var repoName = m.repoName || m.name;
      var isInstalled = installedNames.indexOf(m.name) !== -1 || installedNames.indexOf(repoName) !== -1;
      return Object.assign({}, m, { installed: isInstalled });
    });
    if (S.inputBuf) {
      var q = S.inputBuf.toLowerCase();
      res = res.filter(function(m) { return (m.name || "").toLowerCase().indexOf(q) !== -1 || (m.desc || "").toLowerCase().indexOf(q) !== -1; });
    }
    res.sort(function(a, b) {
      // Sections must be CONTIGUOUS: the renderer emits a heading on every group
      // change, so a pure star sort interleaves headings over and over. Curated
      // first, then everything else; stars order within each group.
      var rank = function(e: MarketplaceRow) { return e.category === "Curated" ? 0 : 1; };
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      var aSt = a.stars != null ? a.stars : -1;
      var bSt = b.stars != null ? b.stars : -1;
      if (bSt !== aSt) return bSt - aSt;
      return (a.name || "").localeCompare(b.name || "");
    });
    return res;
  }
  // The built-in "Featured" catalog (env.ts FEATURED_PLUGINS): standalone plugin
  // repos, not a marketplace.json to fetch. Each row is a plain catalog-shaped
  // item (name/desc/url/category/repoName/full_name) so it falls through the
  // SAME default branch of getMarketplaceActions()/marketplaceInstall() that the
  // community catalog uses: installMarketplacePlugin(url) via the resolved manager.
  if (kind === "featured") {
    var installedFt = loadPlugins();
    var installedFtNames = installedFt.map(function(p) { return p.name; });
    var resFt = FEATURED_PLUGINS.map(function(m) {
      var isInstalled = installedFtNames.indexOf(m.name) !== -1 || installedFtNames.indexOf(m.repoName) !== -1;
      return Object.assign({}, m, { installed: isInstalled });
    });
    if (S.inputBuf) {
      var qFt = S.inputBuf.toLowerCase();
      resFt = resFt.filter(function(m) { return (m.name || "").toLowerCase().indexOf(qFt) !== -1 || (m.desc || "").toLowerCase().indexOf(qFt) !== -1; });
    }
    // group by category (the renderer emits one heading per contiguous group);
    // alphabetical order made almost every row its own single-item section
    resFt.sort(function(a, b) { return (a.category || "").localeCompare(b.category || "") || (a.name || "").localeCompare(b.name || ""); });
    return resFt;
  }
  // A seeded default marketplace (env.ts DEFAULT_MARKETPLACES) not yet added to
  // the host app. Served entirely from S.seedMarketplaces (fetched/cached by
  // fetchSeedMarketplacesAsync), [] until that resolves or if the fetch failed,
  // degrading gracefully rather than throwing. `repo` rides along on every row so
  // an install action can addMarketplace(repo) before installAppPlugin(id, name).
  if (kind === "seed") {
    var seedDef = DEFAULT_MARKETPLACES.find(function(d) { return d.name === marketName; });
    var seedCache = S.seedMarketplaces[marketName];
    var seedPlugins = (seedCache && seedCache.plugins) || [];
    var res3 = seedPlugins.map(function(p: MarketplaceRow): MarketplaceRow {
      return { name: p.name, desc: p.description, source: p.source || marketName, seed: true, id: p.id, repo: (seedDef && seedDef.repo) || (seedCache && seedCache.repo), installed: false };
    });
    if (S.inputBuf) {
      var q3 = S.inputBuf.toLowerCase();
      res3 = res3.filter(function(m) { return (m.name || "").toLowerCase().indexOf(q3) !== -1 || (m.desc || "").toLowerCase().indexOf(q3) !== -1; });
    }
    res3.sort(function(a, b) { return (a.name || "").localeCompare(b.name || ""); });
    return res3;
  }
  // A capability-registered marketplace (e.g. the host app's own plugin
  // marketplace). Browse-only: the capability contract has no generic "install
  // plugin X from marketplace Y" call (only enable/disable/uninstall for an
  // ALREADY-installed foreign plugin, wired into the Installed tab), so these
  // rows carry `capability: true` and getMarketplaceActions() only offers Cancel.
  // foreignPlugins() is cross-referenced purely for the installed/○ dot.
  var mpfn = S.capabilities && S.capabilities.marketplacePlugins;
  var raw: CapabilityMarketplacePlugin[] = [];
  if (typeof mpfn === "function") { try { raw = mpfn(marketName) || []; } catch (e) {} }
  var fpfn = S.capabilities && S.capabilities.foreignPlugins;
  var foreignKeys: Record<string, boolean> = {};
  if (typeof fpfn === "function") {
    try {
      var foreign = fpfn() || [];
      for (var fi = 0; fi < foreign.length; fi++) {
        var f = foreign[fi];
        foreignKeys[(f.name || "") + "@" + (f.source || marketName)] = true;
      }
    } catch (e) {}
  }
  var res2 = raw.map(function(p: CapabilityMarketplacePlugin): MarketplaceRow {
    var key = (p.id || p.name || "") + "@" + marketName;
    return { name: p.name, desc: p.description, source: p.source || marketName, capability: true, id: p.id, installed: !!foreignKeys[key] };
  });
  if (S.inputBuf) {
    var q2 = S.inputBuf.toLowerCase();
    res2 = res2.filter(function(m) { return (m.name || "").toLowerCase().indexOf(q2) !== -1 || (m.desc || "").toLowerCase().indexOf(q2) !== -1; });
  }
  res2.sort(function(a, b) { return (a.name || "").localeCompare(b.name || ""); });
  return res2;
}

/**
 * Single entry point every caller uses (unchanged name/signature on purpose:
 * input.ts/views/plugins.ts never need to know which level is active). Dispatches
 * on S.mkLevel so re-running it after e.g. a catalog fetch always rebuilds
 * whichever level the user is currently looking at.
 */
export function buildMarketplaceList(): MarketplaceRow[] {
  if (S.mkLevel === "plugins" && S.mkMarket) return buildMarketplacePluginsList(S.mkMarket, S.mkMarketKind, S.mkMarketSourceId);
  return buildMarketplaceMarketsList();
}

/**
 * The action-menu entries for a marketplace item. Built once and shared by the renderer and the input
 * handler so their cursor indices always line up.
 */
export function getMarketplaceActions(item: MarketplaceRow, hasUpdater: boolean): ActionRow[] {
  var acts: ActionRow[] = [];
  if (item.seed) {
    // Not yet added to the host app: one action does both steps. addMarketplace(repo)
    // registers it, then installAppPlugin(id, name) installs the plugin, so the user
    // never has to add the marketplace separately first. Absent either capability
    // (e.g. opencode), this stays browse-only like a capability marketplace.
    var addMkFn = S.capabilities && S.capabilities.addMarketplace;
    var installAppFn0 = S.capabilities && S.capabilities.installAppPlugin;
    if (typeof addMkFn === "function" && typeof installAppFn0 === "function" && !item.installed) {
      acts.push({ key: "install-seed", label: "Install (adds " + (item.source || item.repo) + ")" });
    }
    acts.push({ key: "cancel", label: "Cancel" });
    return acts;
  }
  if (item.capability) {
    // Level-2 rows sourced from capabilities.marketplacePlugins() install through
    // capabilities.installAppPlugin(id, marketplace) when the active app registers
    // it (e.g. Claude's `claude plugin install name@marketplace`); otherwise this
    // stays browse-only (opencode has no such capability).
    var installAppFn = S.capabilities && S.capabilities.installAppPlugin;
    if (typeof installAppFn === "function" && !item.installed) {
      acts.push({ key: "install-app", label: "Install" });
    }
    acts.push({ key: "cancel", label: "Cancel" });
    return acts;
  }
  if (!item.installed && hasUpdater) {
    acts.push({ key: "install-git", label: "Install" });
  }
  if (item.url) acts.push({ key: "browser", label: "Open in browser" });
  acts.push({ key: "cancel", label: "Cancel" });
  return acts;
}

/**
 * A git install registers the plugin in plugins.json and then hands it to the resolved manager in a
 * CHILD PROCESS, so the clone + npm install + build (all execSync inside the manager) block that
 * child and the TUI keeps rendering. npx is deliberately not used: it would fetch the published
 * package instead of running the manager this home actually installed. `done(err)` gets null on
 * success or an error string.
 */
export function installMarketplacePlugin(entry: MarketplaceRow, done: (error: string | null) => void): void {
  var url = entry.url;
  var name = entry.repoName || entry.name || String(url || "").replace(/\.git$/, "").split("/").pop();
  if (!name || !url) { done("Install failed: the catalog entry carries no name or url"); return; }
  registerPlugin(name, url);
  setupPlugin({ name: name, url: url }, function (err) {
    done(err ? ("Install failed: " + err) : null);
  });
}

