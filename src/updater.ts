// The plugin manager this home resolved, and the npm-plugin / repo helpers that wrap it.

import { existsSync, readFileSync } from "fs";
import { readJson } from "./json.js";
import { join } from "path";
import { execSync } from "child_process";
import { pathToFileURL } from "url";
import { CONFIG_DIR, CACHE_PKG_DIR, REPOS_DIR, APP_ID, tuiLog } from "./env.js";
import { appNpmPlugins, expandPath } from "./app-descriptor.js";
import { S } from "./state.js";
import { spawnEnv } from "./activity-seam.js";
import { homePaths } from "./home-paths.js";
import { readMarketplaceSources } from "./catalog-sources.js";
import { queryCapability } from "./capability-catalog.js";
import type { CatalogEntry } from "./capability-catalog.js";
import { bootstrapCommand, managerEntries, resolvePluginManager, PLUGIN_MANAGEMENT_CAPABILITY } from "./plugin-manager.js";
import { catalogCacheHours } from "./config.js";
import type { PluginEntry } from "./config.js";

/** One npm plugin the app's own list holds, as the Plugins tab needs it. */
export interface NpmPluginRow {
  /** The package name, with any version suffix stripped. */
  name: string;
  /** The version resolved from a package cache, or an empty string when none was found. */
  version: string;
  /** Whether a version was found at all. */
  installed: boolean;
  /** The entry exactly as the app's list holds it. */
  raw: unknown;
}

/** What resolution may reach the network through. */
export interface PreloadDeps {
  /** Queries the declared marketplace sources. Absent means resolution stays on disk. */
  queryCapability?: (capabilityId: string) => Promise<CatalogEntry[]>;
}

/**
 * The marketplace query, for the one surface whose answer is actionable.
 *
 * @remarks
 * Resolution is otherwise disk only. A query answers "what should the operator install", which is
 * only useful at the install gate, and a network read on the way to the first frame would leave the
 * terminal blank for as long as the fetch takes.
 */
export function marketplaceQuery(): (capabilityId: string) => Promise<CatalogEntry[]> {
  const paths = homePaths(CONFIG_DIR);
  const sources = readMarketplaceSources(paths);
  const windowMs = catalogCacheHours() * 3600000;
  return (capabilityId) => queryCapability(capabilityId, sources, paths, windowMs, { log: tuiLog });
}

/**
 * The manager is an ESM bundle with top-level await, so require() throws ERR_REQUIRE_ASYNC_MODULE
 * under Node and it MUST be import()'d. Resolved and imported once at TUI startup; getUpdater()
 * then answers the sync callers from the cache.
 */
export async function preloadUpdater(deps: PreloadDeps = {}) {
  if (S.UPDATER_MODULE !== undefined) return S.UPDATER_MODULE;
  const paths = homePaths(CONFIG_DIR);
  const ref = await resolvePluginManager(paths, { queryCapability: deps.queryCapability, log: tuiLog });
  S.pluginManager = ref;
  if (!ref) {
    S.UPDATER_MODULE = null;
    tuiLog("no plugin in this home declares the " + PLUGIN_MANAGEMENT_CAPABILITY + " capability");
    return null;
  }
  for (const candidate of managerEntries(paths, ref)) {
    try {
      S.UPDATER_MODULE = await import(pathToFileURL(candidate.entry).href);
      S.UPDATER_PATH = candidate.packageDir || "";
      S.UPDATER_ENTRY = candidate.entry;
      return S.UPDATER_MODULE;
    } catch (e) {
      tuiLog("Failed to load the plugin manager from " + candidate.entry + ": " + e);
    }
  }
  S.UPDATER_MODULE = null;
  return null;
}

/** The plugin manager this home resolved, or null when none did. */
export function resolvedManager() {
  return S.pluginManager || null;
}

/**
 * The command an operator runs to install the manager, or "" while none is known.
 *
 * @remarks
 * Text, never executed here: npx always fetches the published package, whatever this home installed.
 */
export function managerBootstrapCommand() {
  const ref = resolvedManager();
  return ref ? bootstrapCommand(ref, APP_ID) : "";
}

/** The plugin manager module this home resolved, or null when none did. */
export function getUpdater() {
  return S.UPDATER_MODULE || null;
}

/**
 * The manager's package directory, cached by preloadUpdater(). setupPlugin passes it to a
 * child process (via S.UPDATER_ENTRY) so updatePluginPublic runs off the main thread.
 */
export function getUpdaterPath() {
  return S.UPDATER_PATH;
}

/** That manager's version, read from its own package, or an empty string when it cannot be read. */
export function getUpdaterVersion() {
  try {
    if (!getUpdater() || !S.UPDATER_PATH) return "";
    return readJson<{ version?: string }>(join(S.UPDATER_PATH, "package.json"))?.version || "";
  } catch { return ""; }
}

/**
 * Run the updater's updatePluginPublic (git + build + deploy + activate) in a
 * child node process so the git/build execSync inside the manager blocks that
 * child, not our main event loop, so the TUI keeps rendering and animating.
 */
export function setupPlugin(repo: PluginEntry & { branch?: string }, done: (error: string) => void): void {
  var updater = getUpdater();
  // The ENTRY is what the child imports, so it is what readiness means: a home with a deployed
  // bundle and no clone directory has no package dir to report and still updates perfectly well.
  if (!updater || typeof updater.updatePluginPublic !== "function" || !S.UPDATER_ENTRY) {
    done("updater not available");
    return;
  }
  var updaterPath = S.UPDATER_ENTRY;   // the entry .js the child import()s
  // Params go through ENV, not argv: the loader runs under Bun, and `bun -e "code" a b`
  // does NOT expose the trailing args at process.argv[1..] like `node -e` does, so
  // positional args would arrive undefined and updatePluginPublic would build nothing.
  // Env is read identically under both runtimes.
  var script = 'const {pathToFileURL}=require("url"); import(pathToFileURL(process.env.PU_PATH).href).then(function(m){return m.updatePluginPublic(process.env.PU_NAME, process.env.PU_URL||undefined, process.env.PU_BRANCH||undefined);}).then(function(){process.exit(0);}).catch(function(e){console.error((e&&e.message)||e);process.exit(1);});';
  // Tell the child WHICH app and config dir to act on: with neither, it detects its own and can
  // update a different home than the one this TUI is showing.
  var childEnv = spawnEnv({
    PU_PATH: updaterPath, PU_NAME: repo.name, PU_URL: repo.url || "", PU_BRANCH: repo.branch || "",
    PLUGIN_UPDATER_APP: APP_ID,
    HUB_CONFIG_DIR: CONFIG_DIR,
  });
  var child = require("child_process").spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe"], env: childEnv });
  var errBuf = "";
  child.stderr.on("data", function(d: Buffer) { errBuf += d.toString(); });
  child.on("error", function(e: Error) { done(String((e && e.message) || e)); });
  child.on("exit", function(code: number | null) { done(code === 0 ? "" : (errBuf.trim() || "update failed")); });
}

/** The global npm root, asked for once and held, empty when npm could not answer. */
export function getNpmGlobalRoot() {
  if (S.NPM_GLOBAL_ROOT !== null) return S.NPM_GLOBAL_ROOT;
  try { S.NPM_GLOBAL_ROOT = execSync("npm root -g", { timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { S.NPM_GLOBAL_ROOT = ""; }
  return S.NPM_GLOBAL_ROOT;
}

/** The npm plugins the app's own list holds, with whatever version this home actually resolved. */
export function loadNpmPlugins(): NpmPluginRow[] {
  var updater = getUpdater();
  if (updater && typeof updater.getNpmPlugins === "function") {
    try {
      return updater.getNpmPlugins(CONFIG_DIR) as NpmPluginRow[];
    } catch(e) {}
  }
  const declared = appNpmPlugins();
  if (!declared) return [];
  var candidates = declared.configFiles.map(function (file) { return expandPath(file, CONFIG_DIR); });
  var appConfigPath = candidates.find(function (candidate) { return existsSync(candidate); });
  if (!appConfigPath) return [];
  try {
    var raw = readFileSync(appConfigPath, "utf-8");
    var stripped = raw.replace(/^\s*\/\/[^\n]*/gm, "");
    var appConfig = JSON.parse(stripped);
    var plugins: unknown[] = appConfig[declared.pluginsKey] || [];
    return plugins
      .filter(function(p): p is string { return typeof p === "string"; })
      .map(function(p: string): NpmPluginRow {
        var name = p.replace(/@[^@\/]+$/, "") || p;
        var version = "";
        try {
          // the app installs an npm plugin into its declared package cache as <name>@<spec>/
          var pkgCache = declared.packageCache ? expandPath(declared.packageCache, CONFIG_DIR) : "";
          if (pkgCache && existsSync(pkgCache)) {
            var cacheEntries = require("fs").readdirSync(pkgCache);
            for (var entry of cacheEntries) {
              if (entry !== name && entry.indexOf(name + "@") !== 0) continue;
              var cachedPkg = join(pkgCache, entry, "node_modules", name, "package.json");
              version = readJson<{ version?: string }>(cachedPkg)?.version || "";
              if (version) break;
            }
          }
          if (!version) {
            var roots = [CACHE_PKG_DIR, join(CONFIG_DIR, "node_modules"), getNpmGlobalRoot()];
            for (var root of roots) {
              if (!root) continue;
              var pkgPath = join(root, name, "package.json");
              version = readJson<{ version?: string }>(pkgPath)?.version || "";
              if (version) break;
            }
          }
        } catch {}
        return { name: name, version: version, installed: version !== "", raw: p };
      });
  } catch { return []; }
}

/**
 * Force getUpdater() to re-resolve on next call (after installing the engine, so the
 * gate lifts without an app restart).
 */
export function clearUpdaterCache() {
  S.UPDATER_MODULE = undefined;
  S.UPDATER_PATH = undefined;
  S.UPDATER_ENTRY = undefined;
  S.hasUpdater = false;
  S.pluginManager = undefined;
}

/** The clone directory one plugin entry lands in: owner-nested when that layout exists, flat otherwise. */
export function getFolderName(plugin: PluginEntry): string {
  var match = (plugin.url || "").match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
  if (match) {
    var nested = match[1] + "/" + plugin.name;
    if (existsSync(join(REPOS_DIR, nested))) return nested;
  }
  // clones land flat in repos/<name> unless the owner-nested layout exists
  return plugin.name;
}
