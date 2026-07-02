// @ts-nocheck
// Plugin marketplace: async catalog fetches (GitHub topics, npm, awesome list),
// on-disk catalog cache, list building, and one-shot plugin install via git.

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { exec } from "child_process";
import { CATALOG_CACHE_PATH, CACHE_DIR, MCP_CATALOG, OFFICIAL_PLUGINS, APP_NAME, CONFIG_DIR, tuiLog } from "./env.js";
import { S } from "./state.js";
import { loadPlugins, catalogCacheHours } from "./config.js";
import { scheduleRender } from "./views/common.js";
import { buildMcpList } from "./mcp.js";
import { getUpdater } from "./updater.js";

export function invalidateCatalogCache() {
  try { unlinkSync(CATALOG_CACHE_PATH); } catch {}
}

export function loadCatalogCache() {
  try {
    if (!existsSync(CATALOG_CACHE_PATH)) return false;
    var cached = JSON.parse(readFileSync(CATALOG_CACHE_PATH, "utf-8"));
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

// Ensure every official plugin is present in the catalog exactly once.
// If a remote search already returned the repo (case-insensitive full_name or
// name match), enrich that entry in place (mark official, fix category/desc/url)
// WITHOUT overwriting an existing star count. If no match exists, push a shallow
// copy. This is safe to call multiple times because the deduplication check is
// always performed first.
function seedOfficialPlugins() {
  // Official status is AUTHORITATIVE from OFFICIAL_PLUGINS (by full_name): an entry
  // is official iff its full_name is one of ours. First clear any stale official
  // flag — e.g. a fork a PAST build's name-match wrongly promoted and then baked
  // into the on-disk catalog cache (vibheksoni/opencode-antigravity-auth, whose
  // stripped name collided with our "antigravity-auth"). This self-heals bad caches.
  var officialKeys = {};
  for (var ok = 0; ok < OFFICIAL_PLUGINS.length; ok++) {
    officialKeys[OFFICIAL_PLUGINS[ok].full_name.toLowerCase()] = true;
  }
  for (var ei = 0; ei < S.MARKETPLACE_CATALOG.length; ei++) {
    var ce = S.MARKETPLACE_CATALOG[ei];
    if (ce.official && !officialKeys[(ce.full_name || "").toLowerCase()]) {
      ce.official = false;
      if (ce.category === "Official") ce.category = "Community";
    }
  }
  for (var oi = 0; oi < OFFICIAL_PLUGINS.length; oi++) {
    var official = OFFICIAL_PLUGINS[oi];
    var officialKey = official.full_name.toLowerCase();
    // Match by full_name ONLY. Matching by bare name wrongly marked third-party
    // repos official when the GitHub search stripped their "opencode-"/"claude-"
    // prefix into our name (e.g. vibheksoni/opencode-antigravity-auth -> "antigravity-auth").
    var existing = S.MARKETPLACE_CATALOG.find(function(e) {
      return (e.full_name || "").toLowerCase() === officialKey;
    });
    if (existing) {
      // enrich without overwriting stars that may have been fetched already
      existing.official  = true;
      existing.category  = "Official";
      if (!existing.desc)     existing.desc     = official.desc;
      if (!existing.url)      existing.url      = official.url;
      if (!existing.author)   existing.author   = official.author;
      if (!existing.repoName) existing.repoName = official.repoName;
      if (!existing.full_name) existing.full_name = official.full_name;
    } else {
      // not yet in catalog — add a copy (stars left undefined until enrichment runs)
      var copy = {};
      for (var k in official) copy[k] = official[k];
      S.MARKETPLACE_CATALOG.push(copy);
    }
  }
}

export function fetchCatalogsAsync() {
  if (S.catalogFetched) return;
  S.catalogFetched = true;
  var curlCmd = process.platform === "win32" ? "curl.exe" : "curl";
  // even with a warm cache the curated MCP entries still need their stars derived
  // (the cache predates them) — run that enrichment, then skip the cold registry search
  if (loadCatalogCache()) { seedOfficialPlugins(); enrichCuratedMcpStars(); return; }

  var enrichedOnce = false;

  // seed official entries immediately so they appear even before remote fetches finish
  seedOfficialPlugins();

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
    // entries with a pre-seeded repo (env.ts CURATED_MCP_REPOS) skip npm entirely —
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
              var exists = catalog.find(function(m) { return m.name === (catalog === S.MARKETPLACE_CATALOG ? cleanName : it.name); });
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

export function buildMarketplaceList() {
  fetchCatalogsAsync();
  var installed = loadPlugins();
  var installedNames = installed.map(function(p) { return p.name; });
  var res = S.MARKETPLACE_CATALOG.map(function(m) {
    var repoName = m.repoName || m.name;
    var isInstalled = installedNames.indexOf(m.name) !== -1 || installedNames.indexOf(repoName) !== -1;
    return Object.assign({}, m, { installed: isInstalled });
  });
  if (S.inputBuf) {
    var q = S.inputBuf.toLowerCase();
    res = res.filter(function(m) { return (m.name||'').toLowerCase().indexOf(q) !== -1 || (m.desc||'').toLowerCase().indexOf(q) !== -1; });
  }
  // official entries always appear first; within each group sort by stars desc then name asc
  res.sort(function(a, b) {
    var aOff = a.official ? 1 : 0;
    var bOff = b.official ? 1 : 0;
    if (bOff !== aOff) return bOff - aOff;
    var aSt = a.stars != null ? a.stars : -1;
    var bSt = b.stars != null ? b.stars : -1;
    if (bSt !== aSt) return bSt - aSt;
    return (a.name || "").localeCompare(b.name || "");
  });
  return res;
}

// Pure rule: prefer git via the updater unless the catalog entry explicitly
// hints npm, or no updater is loadable — then npm is the only option.
export function selectInstallMethod(entry, hasUpdater) {
  if (hasUpdater && entry.install !== "npm") return "git";
  return "npm";
}

// Delegates to plugin-updater instead of doing the clone ourselves — the loader
// stops duplicating the updater's job. When the module is already loaded, call
// its API directly; otherwise fall back to a transient npx invocation (the one
// sanctioned direct npx call) so install still works before the updater is set up.
// Async so it runs off the main thread (the event loop stays free to animate the
// spinner and render). Every caller passes a `done(err)` callback: err is null on
// success, or an error string.
export function installMarketplacePlugin(entry, done) {
  var repoName = entry.repoName || entry.name;
  var url = entry.url;
  var updater = getUpdater();
  if (updater && typeof updater.updatePluginPublic === "function") {
    Promise.resolve(updater.updatePluginPublic(repoName, url)).then(function() { done(null); })
      .catch(function(e) { done("Install failed: " + ((e && e.message) || e)); });
    return;
  }
  var app = APP_NAME === "Claude Code" ? "claude" : "opencode";
  exec("npx -y plugin-updater@latest add " + url + " --app " + app, { timeout: 120000 }, function(err) {
    done(err ? ("Install failed: " + ((err && err.message) || err)) : null);
  });
}

// Secondary/fallback install method: npm instead of git. Uses the updater's
// installNpmPlugin when loaded (keeps opencode.json/config in sync); otherwise
// falls back to a plain global npm install.
export function installViaNpm(entry, done) {
  var name = entry.repoName || entry.name;
  var updater = getUpdater();
  if (updater && typeof updater.installNpmPlugin === "function") {
    try { var e = updater.installNpmPlugin(name, CONFIG_DIR) || ""; done(e || null); }
    catch (err) { done("npm install failed: " + ((err && err.message) || err)); }
    return;
  }
  exec("npm install -g " + name, { timeout: 120000 }, function(err) {
    done(err ? ("npm install failed: " + ((err && err.message) || err)) : null);
  });
}

