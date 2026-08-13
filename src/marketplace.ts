// @ts-nocheck
// Plugin marketplace: async catalog fetches (GitHub topics, npm, awesome list),
// on-disk catalog cache, list building, and one-shot plugin install via git.

import { existsSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { readJson } from "./json.js";
import { exec } from "child_process";
import { CATALOG_CACHE_PATH, CACHE_DIR, MCP_CATALOG, FEATURED_PLUGINS, APP_NAME, IS_CLAUDE, DEFAULT_MARKETPLACES, SEED_CACHE_PATH, CONFIG_DIR, tuiLog } from "./env.js";
import { S } from "./state.js";
import { loadPlugins, catalogCacheHours, registerPlugin } from "./config.js";
import { scheduleRender } from "./views/common.js";
import { buildMcpList } from "./mcp.js";
import { setupPlugin } from "./updater.js";
import { homePaths } from "./home-paths.js";
import { readMarketplaceSources } from "./catalog-sources.js";
import { catalogFor, categoryOf } from "./capability-catalog.js";

export function invalidateCatalogCache() {
  try { unlinkSync(CATALOG_CACHE_PATH); } catch {}
}

export function invalidateSeedCache() {
  try { unlinkSync(SEED_CACHE_PATH); } catch {}
}

export function loadCatalogCache() {
  try {
    var cached = readJson(CATALOG_CACHE_PATH);
    if (!cached || Date.now() - cached.time > catalogCacheHours() * 3600000) return false;
    if (!Array.isArray(cached.marketplace) || cached.marketplace.length === 0) return false;
    for (var ce of cached.marketplace) S.MARKETPLACE_CATALOG.push(ce);
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

function loadSeedCache() {
  try {
    var cached = readJson(SEED_CACHE_PATH);
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

// A fetched marketplace.json's `plugins` array -> the drill-in shape used by
// buildMarketplacePluginsList. [] on anything malformed (never throws).
export function parseSeedPlugins(json, seedName) {
  var plugins = json && json.plugins;
  if (!Array.isArray(plugins)) return [];
  return plugins.map(function(e) {
    return { id: (e && e.name) || "", name: (e && e.name) || "", description: (e && e.description) || "", source: seedName };
  });
}

// Async, non-blocking, cache-respecting: called (guarded by S.seedFetched) every
// time Level 1 is built, same shape as fetchCatalogsAsync. On a fresh cache hit
// this does nothing further; otherwise it fetches each seed once, trying HEAD
// then main then master, and degrades a seed to count 0 / empty drill-in on
// total failure (offline, renamed default branch, missing file, bad JSON);
// it never throws and never blocks rendering.
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

  function tryBranch(seed, idx) {
    if (idx >= branches.length) {
      S.seedMarketplaces[seed.name] = { plugins: [], count: 0, repo: seed.repo, error: "fetch failed" };
      seedSettled();
      return;
    }
    var url = "https://raw.githubusercontent.com/" + seed.repo + "/" + branches[idx] + "/.claude-plugin/marketplace.json";
    S.catalogPending++;
    exec(curlCmd + ' -sL -H "User-Agent: OpenCode" "' + url + '"', { timeout: 15000 }, function(err, stdout) {
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
 * Non-blocking and guarded by `S.sourceFetched`, the same shape the seed fetch uses: Level 1 renders
 * immediately with an unknown count and fills in when this resolves. It reads through the on-disk
 * catalog cache, so a warm home costs no network at all.
 */
export function fetchSourceCatalogAsync() {
  if (S.sourceFetched) return;
  S.sourceFetched = true;
  var paths = homePaths(CONFIG_DIR);
  catalogFor(readMarketplaceSources(paths), paths, catalogCacheHours() * 3600000, { log: tuiLog })
    .then(function (entries) {
      S.sourceCatalog = entries;
      if (S.pluginSubPage === "marketplace") {
        S.marketplaceItems = buildMarketplaceList();
        scheduleRender();
      }
    })
    .catch(function (error) {
      S.sourceCatalog = [];
      tuiLog("declared marketplace sources could not be read: " + error);
    });
}

// Where a source reads from, which is what tells two rows apart when their labels are similar.
function describeSource(source) {
  if (source.type === "github-org") return "github: " + source.org;
  if (source.type === "manifest") return source.url;
  return source.path;
}

/**
 * One Level-1 row per enabled declared source, counted from the entries it offered.
 *
 * @remarks
 * `entries` is null until the read resolves, which is a different thing from a source that offered
 * nothing: the first renders as an unknown count, the second as zero.
 */
export function sourceRowsFrom(sources, entries) {
  var rows = [];
  for (var i = 0; i < sources.length; i++) {
    var source = sources[i];
    if (source.enabled === false) continue;
    var count = entries === null || entries === undefined
      ? undefined
      : entries.filter(function (entry) { return entry.sourceId === source.id; }).length;
    rows.push({ name: source.label, source: describeSource(source), count: count, builtin: "source", sourceId: source.id });
  }
  return rows;
}

// Claude's community catalog gets a Curated section like opencode's (whose Curated
// entries come from the awesome-opencode scrape): seed the VERIFIED FEATURED_PLUGINS
// repos as category "Curated", one hand-checked source of truth, no new unverified
// repos. full_name matching mirrors the marketplace.json fetches; stars ride in via
// the existing enrichment passes.
function seedCuratedPlugins() {
  if (!IS_CLAUDE) return;   // opencode's Curated section is scraped, not seeded
  for (var ci = 0; ci < FEATURED_PLUGINS.length; ci++) {
    var cur = FEATURED_PLUGINS[ci];
    var curKey = (cur.full_name || "").toLowerCase();
    var existingCur = S.MARKETPLACE_CATALOG.find(function(e) { return (e.full_name || "").toLowerCase() === curKey; });
    if (existingCur) {
      if (existingCur.category !== "Official") existingCur.category = "Curated";
      if (!existingCur.desc) existingCur.desc = cur.desc;
    } else {
      S.MARKETPLACE_CATALOG.push({ name: cur.name, desc: cur.desc, category: "Curated", author: cur.author, repoName: cur.repoName, full_name: cur.full_name, url: cur.url });
    }
  }
}

export function fetchCatalogsAsync() {
  if (S.catalogFetched) return;
  S.catalogFetched = true;
  var curlCmd = process.platform === "win32" ? "curl.exe" : "curl";
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
        exec(curlCmd + ' -sL -H "User-Agent: OpenCode" "https://api.github.com/repos/' + target.full_name + '"', function(err, stdout) {
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
  function npmPkgFromArgs(args) {
    for (var i = 0; i < (args || []).length; i++) {
      var a = args[i];
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
  function repoFromNpmUrl(url) {
    if (!url) return null;
    var clean = url.replace(/^git\+/, "").replace(/^git:\/\//, "https://");
    var m = clean.match(/github\.com[\/:]([^\/]+)\/([^\/]+?)(\.git)?$/);
    return m ? m[1] + "/" + m[2] : null;
  }
  function enrichCuratedMcpStars() {
    var pending = MCP_CATALOG.filter(function(e) {
      return e.curated && e.stars == null && e.command !== "uvx";
    });
    var repoToEntries = {};   // unique repo -> entries waiting on its stars
    function applyStars(fullName, stars) {
      var list = repoToEntries[fullName] || [];
      for (var k = 0; k < list.length; k++) {
        list[k].full_name = fullName;
        if (typeof stars === "number") list[k].stars = stars;
      }
    }
    function fetchRepoStars(fullName) {
      S.catalogPending++;
      exec(curlCmd + ' -sL -H "User-Agent: OpenCode" "https://api.github.com/repos/' + fullName + '"', function(err, stdout) {
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
    function queueRepo(target, fullName) {
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
        exec(curlCmd + ' -sL -H "User-Agent: OpenCode" "https://registry.npmjs.org/' + pkg + '"', function(err, stdout) {
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

  function searchGH(query, catalog, pageNum) {
    S.catalogPending++;
    exec(curlCmd + ' -s -H "User-Agent: OpenCode" "https://api.github.com/search/repositories?q=' + query + '&sort=stars&order=desc&per_page=100&page=' + pageNum + '"', function(err, stdout) {
      fetchDone();
      if (!err && stdout) {
        try {
          var json = JSON.parse(stdout);
          if (json.message) tuiLog("github search: " + json.message);
          if (json.items) {
            for (var i = 0; i < json.items.length; i++) {
              var it = json.items[i];
              var cleanName = it.name.replace(/^claude-|^opencode-/, "");
              // Match plugins by full_name (owner/repo), never by the stripped display
              // name: two different repos can strip to the same name, and matching by
              // name let a community repo overwrite an official entry's star count.
              var exists = catalog.find(function(m) { return catalog === S.MARKETPLACE_CATALOG ? (!!m.full_name && m.full_name === it.full_name) : (m.name === it.name); });
              if (!exists) {
                var newItem = {
                  name: catalog === S.MARKETPLACE_CATALOG ? cleanName : it.name,
                  desc: it.description || "",
                  category: "Community",
                  stars: it.stargazers_count
                };
                if (catalog === S.MARKETPLACE_CATALOG) {
                  newItem.author = it.owner.login;
                  newItem.repoName = it.name;
                  newItem.full_name = it.full_name;
                  newItem.url = "https://github.com/" + it.full_name + ".git";
                } else {
                  newItem.command = "npx";
                  newItem.args = ["-y", it.full_name];
                  newItem.env = {};
                }
                catalog.push(newItem);
              } else {
                exists.stars = it.stargazers_count;
              }
            }
            catalog.sort(function(a, b) { return (b.stars || 0) - (a.stars || 0); });
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

  function searchNpm(keyword) {
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

  // the awesome-opencode list is the curated membership oracle: the fuzzy
  // starred search may only contribute repos that the community list contains,
  // which keeps popular plugins in and look-alike repos out
  var awesomeSet = null;
  function refreshMarketplace() {
    S.MARKETPLACE_CATALOG.sort(function(a, b) { return (b.stars || 0) - (a.stars || 0); });
    if (S.pluginSubPage === "marketplace") {
      S.marketplaceItems = buildMarketplaceList();
      scheduleRender();
    }
  }

  function catalogHas(fullName) {
    var key = fullName.toLowerCase();
    return S.MARKETPLACE_CATALOG.find(function(e) { return (e.full_name || "").toLowerCase() === key; });
  }

  function searchPopular(pageNum) {
    S.catalogPending++;
    exec(curlCmd + ' -s -H "User-Agent: OpenCode" "https://api.github.com/search/repositories?q=opencode&sort=stars&order=desc&per_page=100&page=' + pageNum + '"', function(err, stdout) {
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

  function fetchAwesomeList() {
    S.catalogPending++;
    exec(curlCmd + ' -s "https://raw.githubusercontent.com/awesome-opencode/awesome-opencode/main/README.md"', { maxBuffer: 4 * 1024 * 1024 }, function(err, stdout) {
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
      // whose badge images carry no numbers; membership keeps it precise
      searchPopular(1);
      searchPopular(2);
    });
  }

  var pluginTopic = APP_NAME === "Claude Code" ? "claude-code-plugin" : "opencode-plugin";
  searchGH("topic:" + pluginTopic, S.MARKETPLACE_CATALOG, 1);
  searchGH("topic:" + pluginTopic, S.MARKETPLACE_CATALOG, 2);
  searchNpm(pluginTopic);
  if (APP_NAME !== "Claude Code") fetchAwesomeList();
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
function buildMarketplaceActionRows() {
  var rows = [{ isAction: true, actionKey: "add_plugin_url", name: "＋ Add plugin (git URL)" }];
  var addMk = S.capabilities && S.capabilities.addMarketplace;
  if (typeof addMk === "function") {
    rows.push({ isAction: true, actionKey: "add_marketplace", name: "＋ Add marketplace" });
  }
  return rows;
}

// The two Level-1 rows that are not a declared source: the catalog this file fetches by searching
// GitHub, npm and the awesome list, and the curated standalone list. Both are backed by data this
// file owns rather than by a marketplace anyone declared.
function loaderOwnMarketplaces() {
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
function seedMarketplaceRows(seenNames, seenRepos) {
  var rows = [];
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

// Level 1: the marketplace-of-marketplaces list. Unified Add rows up top, then every source this
// home declares, then the loader's own built-in catalog and curated list, then every marketplace
// the active app's extension registers via capabilities.marketplaces(), deduped by name (an
// earlier entry always wins a name collision), then the seeded defaults not already covered by a
// real entry.
export function buildMarketplaceMarketsList() {
  fetchCatalogsAsync();
  fetchSeedMarketplacesAsync();
  fetchSourceCatalogAsync();
  var seen = {};
  var seenRepos = {};
  var rows = buildMarketplaceActionRows();
  // Declared sources first: they are what this home actually asked for, and the built-in catalog is a
  // fallback rather than the headline.
  var declared = sourceRowsFrom(readMarketplaceSources(homePaths(CONFIG_DIR)), S.sourceCatalog);
  for (var di = 0; di < declared.length; di++) { rows.push(declared[di]); seen[declared[di].name] = true; }
  var own = loaderOwnMarketplaces();
  for (var oi = 0; oi < own.length; oi++) { if (seen[own[oi].name]) continue; rows.push(own[oi]); seen[own[oi].name] = true; }
  var mfn = S.capabilities && S.capabilities.marketplaces;
  if (typeof mfn === "function") {
    var caps = [];
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

// Level 2: a single marketplace's plugins, routed by kind. A declared source's entries come from its
// own manifests (S.sourceCatalog), grouped by the category each entry's capabilities imply. The
// built-in community catalog is served from the loader's own fetched catalog (S.MARKETPLACE_CATALOG,
// which already carries an "Official"/"Curated" category on some entries). The curated Featured list
// is served from the static FEATURED_PLUGINS list (env.ts). A seed is served from S.seedMarketplaces.
// Anything else is assumed to be an app-registered capability marketplace, served through
// capabilities.marketplacePlugins(name), which returns [] if the capability is absent or the
// marketplace is unknown, so this degrades to an empty list rather than throwing.
export function buildMarketplacePluginsList(marketName, marketKind, sourceId) {
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
      .map(function (e) {
        return {
          name: e.id,
          desc: e.description,
          url: e.url,
          repoName: e.id,
          full_name: (e.url || "").replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, ""),
          category: categoryOf(e),
          sourceId: e.sourceId,
          installed: installedHere.indexOf(e.id) !== -1,
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
      var rank = function(e) { return e.category === "Curated" ? 0 : 1; };
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
    var res3 = seedPlugins.map(function(p) {
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
  var raw = [];
  if (typeof mpfn === "function") { try { raw = mpfn(marketName) || []; } catch (e) {} }
  var fpfn = S.capabilities && S.capabilities.foreignPlugins;
  var foreignKeys = {};
  if (typeof fpfn === "function") {
    try {
      var foreign = fpfn() || [];
      for (var fi = 0; fi < foreign.length; fi++) {
        var f = foreign[fi];
        foreignKeys[(f.name || "") + "@" + (f.source || marketName)] = true;
      }
    } catch (e) {}
  }
  var res2 = raw.map(function(p) {
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

// Single entry point every caller uses (unchanged name/signature on purpose:
// input.ts/views/plugins.ts never need to know which level is active). Dispatches
// on S.mkLevel so re-running it after e.g. a catalog fetch always rebuilds
// whichever level the user is currently looking at.
export function buildMarketplaceList() {
  if (S.mkLevel === "plugins" && S.mkMarket) return buildMarketplacePluginsList(S.mkMarket, S.mkMarketKind, S.mkMarketSourceId);
  return buildMarketplaceMarketsList();
}

// The action-menu entries for a marketplace item. Built once and shared by the renderer and the input
// handler so their cursor indices always line up.
export function getMarketplaceActions(item, hasUpdater) {
  var acts = [];
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

// A git install registers the plugin in plugins.json and then hands it to the resolved manager in a
// CHILD PROCESS, so the clone + npm install + build (all execSync inside the manager) block that
// child and the TUI keeps rendering. npx is deliberately not used: it would fetch the published
// package instead of running the manager this home actually installed. `done(err)` gets null on
// success or an error string.
export function installMarketplacePlugin(entry, done) {
  var url = entry.url;
  var name = entry.repoName || entry.name || String(url || "").replace(/\.git$/, "").split("/").pop();
  if (!name || !url) { done("Install failed: the catalog entry carries no name or url"); return; }
  registerPlugin(name, url);
  setupPlugin({ name: name, url: url }, function (err) {
    done(err ? ("Install failed: " + err) : null);
  });
}

