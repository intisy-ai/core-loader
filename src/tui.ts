#!/usr/bin/env bun
// @ts-nocheck

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { S } from "./state.js";
import { APP_NAME, CLI_CMD, NPM_PKG, CONFIG_DIR, CACHE_DIR, UPDATE_CHECK_PATH, REPOS_DIR, PLUGINS_DIR, tuiLog } from "./env.js";
import { hideCur, showCur, cleanup } from "./out.js";
import { getFolderName, installUpdater, clearUpdaterCache } from "./updater.js";
import { loadConfig, saveConfig, migrateConfigs, loadPlugins, autoUpdateCheck, updateCheckDelayMs, updateCheckIntervalHours, defaultTab } from "./config.js";
import { flash } from "./views/common.js";
import { buildMcpList } from "./mcp.js";
import { buildMarketplaceList } from "./marketplace.js";
import { buildCombinedPluginList } from "./plugins.js";
import { buildList, outputDir } from "./projects.js";
import { render } from "./views/render.js";
import { parseKey, handleKey, handleInputData, handlePluginInputData, handleSearchData, handleTabInputData, handleConfigInputData, switchPluginSubPage } from "./input.js";

global.OpenCodeAPI = {
  getReposDir: function() { return REPOS_DIR; },
  getPluginsDir: function() { return PLUGINS_DIR; },
  getConfigDir: function() { return CONFIG_DIR; },
  log: function(msg) { flash(msg); render(); },
  
  // Deploy a plugin binary/script to the active plugins directory
  deployPlugin: function(pluginName, sourcePath) {
    const fs = require('fs');
    const path = require('path');
    if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    
    const pluginFile = pluginName.endsWith('.js') ? pluginName : pluginName + '.js';
    const destPath = path.join(PLUGINS_DIR, pluginFile);
    
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, destPath);
    }
  },
  
  // Remove a plugin's deployed files
  removePluginFiles: function(pluginName) {
    const fs = require('fs');
    const path = require('path');
    const pluginFile = pluginName.endsWith('.js') ? pluginName : pluginName + '.js';
    const deployedPath = path.join(PLUGINS_DIR, pluginFile);
    if (fs.existsSync(deployedPath)) {
      try { fs.unlinkSync(deployedPath); } catch {}
    }
    
    const folderName = pluginName.replace(/[^a-zA-Z0-9-]/g, '-');
    const repoDir = path.join(REPOS_DIR, "intisy", folderName);
    if (fs.existsSync(repoDir)) {
      try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    }
  }
};

migrateConfigs();

function checkForUpdates() {
  try {
    var legacyCheck = join(CONFIG_DIR, "oc-last-update-check");
    if (!existsSync(UPDATE_CHECK_PATH) && existsSync(legacyCheck)) {
      try {
        if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
        copyFileSync(legacyCheck, UPDATE_CHECK_PATH);
      } catch {}
    }
    if (existsSync(UPDATE_CHECK_PATH)) {
      var lastCheck = parseInt(readFileSync(UPDATE_CHECK_PATH, "utf-8").trim(), 10);
      if (Date.now() - lastCheck < updateCheckIntervalHours() * 3600000) return;
    }

    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(UPDATE_CHECK_PATH, String(Date.now()));

    exec(CLI_CMD + " --version", { timeout: 15000 }, function(versionError, installedOut) {
      if (versionError) return;
      exec("npm view " + NPM_PKG + " version", { timeout: 20000 }, function(viewError, latestOut) {
        if (viewError) return;
        var installed = (installedOut || "").trim();
        var latest = (latestOut || "").trim();
        if (!latest || !installed || latest === installed) return;
        flash("Updating " + APP_NAME + " " + installed + " -> " + latest + " in the background");
        render();
        exec("npm install -g " + NPM_PKG + "@latest", { timeout: 180000 }, function(installError) {
          tuiLog(installError ? "self-update failed: " + installError.message : "self-updated to " + latest);
          if (!installError) { flash(APP_NAME + " updated to " + latest + " (restart to apply)"); render(); }
        });
      });
    });
  } catch (e) { tuiLog("update check failed: " + e.message); }
}

// deferred so the TUI renders immediately instead of waiting on version checks
if (autoUpdateCheck()) setTimeout(checkForUpdates, updateCheckDelayMs());


// Registry Pattern: plugins extend the TUI by exporting a function from tui-extension.js
// The function receives a tuiApi object with registerTab() to add custom tabs
export var tuiApi = {
  registerTab: function(tab) {
    if (tab && tab.id && tab.label && !S.customTabs.some(function(t) { return t.id === tab.id; })) {
      S.customTabs.push(tab);   // dedup by id so a double-load can't add the tab twice
    }
  },
  loadConfig: function() { return loadConfig(); },
  saveConfig: function(cfg) { return saveConfig(cfg); },
  loadPlugins: function() { return loadPlugins(); },
  flash: function(msg) { flash(msg); },
  // let a custom tab capture raw text (search boxes); routes keys to its handleKey
  setTextInput: function(on) { S.mode = on ? "tabinput" : "list"; },
  // redraw on demand (a tab finished async work off the keypress path, e.g. a
  // login input resolving or a loopback callback auto-completing)
  refresh: function() { render(); },
  // suspend the loader TUI, run a blocking raw-stdin routine (the shared account
  // menu), then re-attach input and redraw
  runBlocking: function(fn) { return runBlocking(fn); }
};

function runBlocking(fn) {
  try { process.stdin.removeListener("data", onData); } catch {}
  try { process.stdin.setRawMode(false); } catch {}
  try { process.stdin.pause(); } catch {}
  showCur();
  // Pausing stdin drops the last event-loop ref. If fn awaits async work that
  // doesn't itself touch stdin (e.g. an input-action's PKCE digest / fetch),
  // the loop would otherwise idle-exit (code 0) before fn settles. Hold it open.
  var keepAlive = setInterval(function() {}, 1 << 30);
  return Promise.resolve().then(fn).catch(function() {}).then(function() {
    clearInterval(keepAlive);
    try { process.stdin.setRawMode(true); } catch {}
    try { process.stdin.resume(); } catch {}
    process.stdin.on("data", onData);
    hideCur();
    render();
  });
}

function loadCustomTabs() {
  S.customTabs = [];
  function loadExt(extPath) {
    if (!extPath || !existsSync(extPath)) return;
    try {
      var mod = require(extPath);
      var fn = (mod && mod.default) || mod;
      if (typeof fn === "function") fn(tuiApi);
    } catch(e) { tuiLog("custom tab load failed (" + extPath + "): " + e); }
  }
  // 1. The active loader declares its own extension via env (absolute path)
  loadExt(process.env.HUB_TUI_EXTENSION);
  // 2. Installed plugins may ship a tui-extension.js in their repo root
  try {
    var pl = loadPlugins();
    for (var i = 0; i < pl.length; i++) {
      loadExt(join(REPOS_DIR, getFolderName(pl[i]), "tui-extension.js"));
    }
  } catch(e) {}
}

var { exec } = require("child_process");


S.items = buildList();

S.pluginItems = buildCombinedPluginList();

S.mcpItems = buildMcpList("All");
S.marketplaceItems = buildMarketplaceList();

process.on("exit", function() { showCur(); });
process.on("SIGINT", function() { cleanup(); process.exit(1); });
process.on("SIGTERM", function() { cleanup(); process.exit(1); });
try { process.stderr.on("resize", function() { render(); }); } catch(e) {}




// Direct argument handling (skip TUI)
var arg = process.argv[2];
if (arg) {
  if (arg === "test") {
    console.log("\x1b[36mRunning Loader Tests...\x1b[0m\n");
    var passed = 0, failed = 0;

    console.log("Core Checks:");
    const fs = require('fs');
    if (fs.existsSync(PLUGINS_DIR)) {
      console.log("\x1b[32m  [✓]\x1b[0m Plugin directory exists"); passed++;
    } else {
      console.log("\x1b[31m  [✗]\x1b[0m Plugin directory missing"); failed++;
    }

    var testApi = {
      addTest: function(category, name, fn) {
        console.log("\n" + category + " Checks:");
        try {
          var res = fn();
          if (res && res.passed) {
            console.log("\x1b[32m  [✓]\x1b[0m " + name + " (" + res.message + ")");
            passed++;
          } else {
            console.log("\x1b[31m  [✗]\x1b[0m " + name + " (" + (res ? res.message : "Failed") + ")");
            failed++;
          }
        } catch(e) {
          console.log("\x1b[31m  [✗]\x1b[0m " + name + " (Error: " + e.message + ")");
          failed++;
        }
      }
    };
    
    var plugins = loadPlugins();
    plugins.forEach(function(p) {
      if (!p.enabled) return;
      var pluginPath = join(PLUGINS_DIR, p.pluginFile || (p.name + ".js"));
      if (fs.existsSync(pluginPath)) {
        try {
          var mod = require(pluginPath);
          if (mod.registerTests) {
            mod.registerTests(testApi);
          }
        } catch(e) {}
      }
    });
    
    console.log("\n\x1b[36mResults: " + passed + " passed, " + failed + " failed.\x1b[0m");
    process.exit(failed > 0 ? 1 : 0);
  }
  if (/^\d+$/.test(arg)) {
    var idx = parseInt(arg) - 1;
    if (idx >= 0 && idx < S.items.length) {
      outputDir(S.items[idx].dir);
      process.exit(0);
    }
    process.exit(42);
  }
  var match = S.items.find(function(it) { return it.name.toLowerCase().indexOf(arg.toLowerCase()) !== -1; });
  if (!match) match = S.items.find(function(it) { return it.dir.toLowerCase().indexOf(arg.toLowerCase()) !== -1; });
  if (match) {
    outputDir(match.dir);
    process.exit(0);
  }
  process.exit(42);
}

// load loader/plugin-provided tabs, then honor an initial-tab hint (e.g. the
// cc wrapper sets HUB_OPEN_TAB=provider for `cc auth login`)
loadCustomTabs();
if (process.env.HUB_OPEN_TAB) {
  S.page = "plugins";
  S.pluginSubPage = process.env.HUB_OPEN_TAB;
} else {
  // honor the configured initial tab (validated; defaults to "projects" =
  // current behavior) only when the wrapper hasn't forced a tab via env
  S.page = defaultTab();
}

// disable any mouse reporting a previous program left enabled — pointer
// movement otherwise arrives as input bytes and triggers random key handlers
process.stderr.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l");
hideCur();
render();
process.stdin.setRawMode(true);
process.stdin.resume();


function onData(buf) {
  var key = parseKey(buf);

  if (S.globalKeyHandler === "updater_install") {
    // Tab (and left/right) still switch the plugins sub-tab so the user isn't
    // trapped on the gated Installed view — they can move to the Marketplace.
    if (key === "tab" || key === "left" || key === "right") {
      switchPluginSubPage();
      S.globalKeyHandler = null;   // cleared here; buildPlugins re-sets it only if the new sub-tab is the gated Installed one
      render();
      return;
    }
    if (key === "enter" || key === "space") {
      process.stdout.write("\x1b[?25h\n\x1b[36mInstalling updater plugin (fetching + running)...\x1b[0m\n");
      var installErr = installUpdater(CONFIG_DIR, APP_NAME);
      if (installErr) { tuiLog(installErr); flash(installErr); }
      clearUpdaterCache();   // installUpdater ran the engine; re-resolve it now so the gate lifts
      S.globalKeyHandler = null;
      S.pluginItems = buildCombinedPluginList();
      render();   // buildPlugins re-detects the engine; if it still can't resolve, the gate simply re-shows
    }
    if (key === "escape" || key === "q" || buf[0] === 3) process.exit(0);
    return;
  }
  
  if (S.mode === "input") { handleInputData(buf); render(); return; }
  if (S.mode === "pinput") { handlePluginInputData(buf); render(); return; }
  if (S.mode === "pcfginput") { handleConfigInputData(buf); render(); return; }
  if (S.mode === "search") { handleSearchData(buf); render(); return; }
  if (S.mode === "tabinput") { handleTabInputData(buf); render(); return; }
  var key = parseKey(buf);
  if (key) {
    // Never let a handler error crash the whole TUI: surface it as a status
    // message and keep the loop alive so the user stays in their menu.
    try { handleKey(key); }
    catch (e) { try { flash("Error: " + ((e && e.message) || e)); } catch (_) {} }
    render();
  }
}
process.stdin.on("data", onData);
// @ts-nocheck
