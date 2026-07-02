// @ts-nocheck
// plugin-updater engine discovery and the npm-plugin / repo helpers that wrap it.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { PLUGINS_DIR, CONFIG_DIR, CACHE_PKG_DIR, REPOS_DIR, tuiLog } from "./env.js";
import { S } from "./state.js";

export function getUpdater() {
  if (S.UPDATER_MODULE !== undefined) return S.UPDATER_MODULE;
  const fs = require('fs');
  const path = require('path');
  const updaterCandidates = [
    path.join(PLUGINS_DIR, "plugin-updater", "index.js"),
    path.join(CONFIG_DIR, "node_modules", "plugin-updater"),
    path.join(require('os').homedir(), ".cache", "opencode", "packages", "plugin-updater@latest", "node_modules", "plugin-updater"),
  ];
  // under claude the updater arrives via npx, whose cache lives in ~/.npm/_npx
  try {
    const npxRoot = path.join(require('os').homedir(), ".npm", "_npx");
    for (const npxEntry of fs.readdirSync(npxRoot)) {
      const candidate = path.join(npxRoot, npxEntry, "node_modules", "plugin-updater");
      if (fs.existsSync(candidate)) { updaterCandidates.push(candidate); break; }
    }
  } catch {}
  const updaterPath = updaterCandidates.find(function(p) { return fs.existsSync(p); });
  if (updaterPath) {
    try {
      S.UPDATER_MODULE = require(updaterPath);
      S.UPDATER_PATH = updaterPath;
      return S.UPDATER_MODULE;
    } catch(e) {
      tuiLog("Failed to load updater plugin from " + updaterPath + ": " + e);
    }
  }
  S.UPDATER_MODULE = null;
  return null;
}

// The resolved bundle path getUpdater() cached — used to run updatePluginPublic
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
// child, not our main event loop — the TUI keeps rendering and animating.
export function setupPlugin(repo, done) {
  var updater = getUpdater();
  if (!updater || typeof updater.updatePluginPublic !== "function" || !getUpdaterPath()) {
    done("updater not available");
    return;
  }
  var updaterPath = getUpdaterPath();
  // Params go through ENV, not argv: the loader runs under Bun, and `bun -e "code" a b`
  // does NOT expose the trailing args at process.argv[1..] like `node -e` does — so
  // positional args arrived undefined and updatePluginPublic built nothing. Env is
  // read identically under both runtimes.
  var script = 'const {pathToFileURL}=require("url"); import(pathToFileURL(process.env.PU_PATH).href).then(function(m){return m.updatePluginPublic(process.env.PU_NAME, process.env.PU_URL||undefined, process.env.PU_BRANCH||undefined);}).then(function(){process.exit(0);}).catch(function(e){console.error((e&&e.message)||e);process.exit(1);});';
  var childEnv = Object.assign({}, process.env, { PU_PATH: updaterPath, PU_NAME: repo.name, PU_URL: repo.url || "", PU_BRANCH: repo.branch || "" });
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
export function installUpdater(configDir, appName) {
  try {
    if (appName === "Claude Code") {
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
      execSync("npm install -g plugin-updater", { timeout: 180000, stdio: "ignore" });
      var ocPath = join(configDir, "opencode.json");
      var ocData = {};
      if (existsSync(ocPath)) {
        try { ocData = JSON.parse(readFileSync(ocPath, "utf-8").replace(/^\s*\/\/[^\n]*/gm, "")); } catch {}
      }
      if (!Array.isArray(ocData.plugin)) ocData.plugin = [];
      if (ocData.plugin.indexOf("plugin-updater") === -1) ocData.plugin.unshift("plugin-updater");
      writeFileSync(ocPath, JSON.stringify(ocData, null, 2), "utf-8");
    }
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
