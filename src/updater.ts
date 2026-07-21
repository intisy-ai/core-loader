// @ts-nocheck
// plugin-updater engine discovery and the npm-plugin / repo helpers that wrap it.

import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { PLUGINS_DIR, CONFIG_DIR, CACHE_PKG_DIR, REPOS_DIR, IS_CLAUDE, tuiLog } from "./env.js";
import { S } from "./state.js";

// Every place the deployed plugin-updater might live. The npx roots differ per OS:
// ~/.npm/_npx on unix, %LOCALAPPDATA%/%APPDATA%\npm-cache\_npx on Windows; all must
// be checked or the loader reports "Updater Plugin Missing" on Windows.
function updaterCandidatePaths() {
  const fs = require('fs'); const path = require('path'); const os = require('os');
  const cands = [
    path.join(PLUGINS_DIR, "plugin-updater", "index.js"),
    path.join(CONFIG_DIR, "node_modules", "plugin-updater"),
    path.join(os.homedir(), ".cache", "opencode", "packages", "plugin-updater@latest", "node_modules", "plugin-updater"),
  ];
  const npxRoots = [
    path.join(os.homedir(), ".npm", "_npx"),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "npm-cache", "_npx") : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm-cache", "_npx") : null,
  ].filter(Boolean);
  for (const npxRoot of npxRoots) {
    try {
      for (const entry of fs.readdirSync(npxRoot)) {
        cands.push(path.join(npxRoot, entry, "node_modules", "plugin-updater"));
      }
    } catch {}
  }
  return cands.filter(function(p) { return fs.existsSync(p); });
}

// plugin-updater is ESM with top-level await, so require() throws ERR_REQUIRE_ASYNC_MODULE
// under Node; it MUST be import()'d. Preload it once (async) at TUI startup; getUpdater()
// then returns the cached module synchronously to all the sync callers.
export async function preloadUpdater() {
  if (S.UPDATER_MODULE !== undefined) return S.UPDATER_MODULE;
  const fs = require('fs'); const path = require('path'); const { pathToFileURL } = require('url');
  for (const p of updaterCandidatePaths()) {
    let entry = p;
    if (!entry.endsWith(".js")) {
      try { entry = path.join(p, JSON.parse(fs.readFileSync(path.join(p, "package.json"), "utf8")).main || "index.js"); }
      catch { entry = path.join(p, "index.js"); }
    }
    try {
      S.UPDATER_MODULE = await import(pathToFileURL(entry).href);
      S.UPDATER_PATH = p;        // package dir, for the version lookup
      S.UPDATER_ENTRY = entry;   // resolved .js, the child process import()s this
      return S.UPDATER_MODULE;
    } catch (e) { tuiLog("Failed to load updater from " + entry + ": " + e); }
  }
  S.UPDATER_MODULE = null;
  return null;
}

export function getUpdater() {
  return S.UPDATER_MODULE || null;
}

// The resolved bundle path getUpdater() cached, used to run updatePluginPublic
// in a child process (setupPlugin) so the update doesn't block the main thread.
export function getUpdaterPath() {
  return S.UPDATER_PATH;
}

export function getUpdaterVersion() {
  try {
    if (!getUpdater() || !S.UPDATER_PATH) return "";
    var pkgPath = S.UPDATER_PATH.endsWith("index.js")
      ? join(dirname(S.UPDATER_PATH), "package.json")
      : join(S.UPDATER_PATH, "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version || "";
  } catch { return ""; }
}

// Run the updater's updatePluginPublic (git + build + deploy + activate) in a
// child node process so the git/build execSync inside plugin-updater blocks that
// child, not our main event loop, so the TUI keeps rendering and animating.
export function setupPlugin(repo, done) {
  var updater = getUpdater();
  if (!updater || typeof updater.updatePluginPublic !== "function" || !getUpdaterPath()) {
    done("updater not available");
    return;
  }
  var updaterPath = S.UPDATER_ENTRY || getUpdaterPath();   // the entry .js the child import()s
  // Params go through ENV, not argv: the loader runs under Bun, and `bun -e "code" a b`
  // does NOT expose the trailing args at process.argv[1..] like `node -e` does, so
  // positional args would arrive undefined and updatePluginPublic would build nothing.
  // Env is read identically under both runtimes.
  var script = 'const {pathToFileURL}=require("url"); import(pathToFileURL(process.env.PU_PATH).href).then(function(m){return m.updatePluginPublic(process.env.PU_NAME, process.env.PU_URL||undefined, process.env.PU_BRANCH||undefined);}).then(function(){process.exit(0);}).catch(function(e){console.error((e&&e.message)||e);process.exit(1);});';
  // Tell the child WHICH app + config dir to update: without these it guesses from
  // argv (no "claude") + ~/.<app>, so it updated the wrong home and the loader's own
  // repos/<name> clone never advanced (updates "did nothing" / kept showing available).
  var childEnv = Object.assign({}, process.env, {
    PU_PATH: updaterPath, PU_NAME: repo.name, PU_URL: repo.url || "", PU_BRANCH: repo.branch || "",
    PLUGIN_UPDATER_APP: IS_CLAUDE ? "claude" : "opencode",
    HUB_CONFIG_DIR: CONFIG_DIR,
  });
  var child = require("child_process").spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe"], env: childEnv });
  var errBuf = "";
  child.stderr.on("data", function(d) { errBuf += d.toString(); });
  child.on("error", function(e) { done(String((e && e.message) || e)); });
  child.on("exit", function(code) { done(code === 0 ? "" : (errBuf.trim() || "update failed")); });
}

export function getNpmGlobalRoot() {
  if (S.NPM_GLOBAL_ROOT !== null) return S.NPM_GLOBAL_ROOT;
  try { S.NPM_GLOBAL_ROOT = execSync("npm root -g", { timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { S.NPM_GLOBAL_ROOT = ""; }
  return S.NPM_GLOBAL_ROOT;
}

export function loadNpmPlugins() {
  var updater = getUpdater();
  if (updater && typeof updater.getNpmPlugins === "function") {
    try {
      return updater.getNpmPlugins(CONFIG_DIR);
    } catch(e) {}
  }
  var ocPath = existsSync(join(CONFIG_DIR, "opencode.json")) ? join(CONFIG_DIR, "opencode.json") : join(CONFIG_DIR, "opencode.jsonc");
  if (!existsSync(ocPath)) return [];
  try {
    var raw = readFileSync(ocPath, "utf-8");
    var stripped = raw.replace(/^\s*\/\/[^\n]*/gm, "");
    var oc = JSON.parse(stripped);
    var plugins = oc.plugin || [];
    return plugins
      .filter(function(p) { return typeof p === "string"; })
      .map(function(p) {
        var name = p.replace(/@[^@\/]+$/, "") || p;
        var version = "";
        try {
          // opencode installs npm plugins into ~/.cache/opencode/packages/<name>@<spec>/
          var pkgCache = join(homedir(), ".cache", "opencode", "packages");
          if (existsSync(pkgCache)) {
            var cacheEntries = require("fs").readdirSync(pkgCache);
            for (var entry of cacheEntries) {
              if (entry !== name && entry.indexOf(name + "@") !== 0) continue;
              var cachedPkg = join(pkgCache, entry, "node_modules", name, "package.json");
              if (existsSync(cachedPkg)) {
                version = JSON.parse(readFileSync(cachedPkg, "utf-8")).version || "";
                break;
              }
            }
          }
          if (!version) {
            var roots = [CACHE_PKG_DIR, join(CONFIG_DIR, "node_modules"), getNpmGlobalRoot()];
            for (var root of roots) {
              if (!root) continue;
              var pkgPath = join(root, name, "package.json");
              if (existsSync(pkgPath)) {
                version = JSON.parse(readFileSync(pkgPath, "utf-8")).version || "";
                break;
              }
            }
          }
        } catch {}
        return { name: name, version: version, installed: version !== "", raw: p };
      });
  } catch { return []; }
}

// App-aware install of the plugin-updater engine itself (the bootstrap that lets
// the loader manage git plugins). Claude registers a SessionStart hook that runs
// the transient `npx plugin-updater@latest`; OpenCode installs it globally and
// lists it in opencode.json. Idempotent. Returns "" on success or an error string.
// Force getUpdater() to re-resolve on next call (after installing the engine, so the
// gate lifts without an app restart).
export function clearUpdaterCache() {
  S.UPDATER_MODULE = undefined;
  S.UPDATER_PATH = undefined;
  S.UPDATER_ENTRY = undefined;
  S.hasUpdater = false;
}

// Self-update the engine, the one plugin permitted to use npm/npx. Claude: drop the
// cached npx copy (npx pins @latest) and re-fetch+run the newest published version.
// OpenCode: update the opencode.jsonc npm plugin via the engine's own API. Returns
// "" on success or an error string.
// Runs OFF-THREAD via a child process and reports through `done(err)` so a blocking
// execSync never freezes the busy spinner or the TUI's event loop. Keeps S.busy
// owned by the caller; calls done("") on success.
export function updateUpdater(done) {
  var finish = typeof done === "function" ? done : function () {};
  var spawn = require("child_process").spawn;
  try {
    if (IS_CLAUDE) {
      // drop the cached npx copy (npx pins @latest) so the newest is refetched
      try {
        var npxRoot = join(homedir(), ".npm", "_npx");
        for (var entry of readdirSync(npxRoot)) {
          if (existsSync(join(npxRoot, entry, "node_modules", "plugin-updater"))) rmSync(join(npxRoot, entry), { recursive: true, force: true });
        }
      } catch { /* no cache to clear */ }
    }
    var command = IS_CLAUDE
      ? "npx -y plugin-updater@latest run --app claude"
      : "npm update -g plugin-updater";
    var child = spawn(command, { stdio: ["ignore", "ignore", "pipe"], shell: true });
    var err = "";
    child.stderr.on("data", function (d) { err += d.toString(); });
    child.on("error", function (e) { finish("updater self-update failed: " + ((e && e.message) || e)); });
    child.on("exit", function (code) {
      clearUpdaterCache();
      finish(code === 0 ? "" : ("updater self-update failed" + (err.trim() ? ": " + err.trim() : "")));
    });
  } catch (e) {
    finish("updater self-update failed: " + ((e && e.message) || e));
  }
}

// onStep(label): optional progress reporter, called before each blocking step so a
// caller can re-render (the steps run via synchronous execSync, so this is coarse
// step-by-step progress, not a live spinner).
export function installUpdater(configDir, appName, onStep) {
  var step = typeof onStep === "function" ? onStep : function () {};
  try {
    var appFlag = appName === "Claude Code" ? "claude" : "opencode";
    if (appName === "Claude Code") {
      step("Registering the SessionStart hook");
      var settingsPath = join(configDir, "settings.json");
      var settings = {};
      try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
      var hooks = settings.hooks || (settings.hooks = {});
      var sessionStart = hooks.SessionStart || (hooks.SessionStart = []);
      if (!JSON.stringify(sessionStart).includes("plugin-updater")) {
        sessionStart.push({ hooks: [{ type: "command", command: "npx -y plugin-updater@latest run --app claude" }] });
      }
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    } else {
      step("Installing the npm package (npm i -g)");
      execSync("npm install -g plugin-updater", { timeout: 180000, stdio: "ignore" });
      step("Registering it in opencode.json");
      var ocPath = join(configDir, "opencode.json");
      var ocData = {};
      if (existsSync(ocPath)) {
        try { ocData = JSON.parse(readFileSync(ocPath, "utf-8").replace(/^\s*\/\/[^\n]*/gm, "")); } catch {}
      }
      if (!Array.isArray(ocData.plugin)) ocData.plugin = [];
      if (ocData.plugin.indexOf("plugin-updater") === -1) ocData.plugin.unshift("plugin-updater");
      writeFileSync(ocPath, JSON.stringify(ocData, null, 2), "utf-8");
    }
    // Run the engine now so it's fetched + resolvable immediately (populates the npx
    // cache getUpdater() looks in); installing shouldn't require an app restart.
    step("Fetching + building the engine");
    try { execSync("npx -y plugin-updater@latest run --app " + appFlag, { timeout: 180000, stdio: "ignore" }); } catch { /* best effort; getUpdater re-checks */ }
    step("Done");
    return "";
  } catch (e) {
    return "Failed to install updater: " + ((e && e.message) || e);
  }
}

export function getFolderName(plugin) {
  var match = (plugin.url || "").match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
  if (match) {
    var nested = match[1] + "/" + plugin.name;
    if (existsSync(join(REPOS_DIR, nested))) return nested;
  }
  // plugin-updater clones flat into repos/<name>
  return plugin.name;
}
