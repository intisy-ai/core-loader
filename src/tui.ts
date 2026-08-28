#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { S } from "./state.js";
import { librariesTab } from "./views/libraries.js";
import { APP_NAME, CLI_CMD, NPM_PKG, CONFIG_DIR, CACHE_DIR, UPDATE_CHECK_PATH, REPOS_DIR, PLUGINS_DIR, tuiLog } from "./env.js";
import { hideCur, showCur, cleanup } from "./out.js";
import { getFolderName, clearUpdaterCache, marketplaceQuery, preloadUpdater } from "./updater.js";
import { startPluginHost } from "./plugin-surface.js";
import { refreshScreenSpecs } from "./views/screens.js";
import { loadConfig, saveConfig, migrateConfigs, loadPlugins, autoUpdateCheck, updateCheckDelayMs, updateCheckIntervalHours, defaultTab } from "./config.js";
import { flash } from "./views/common.js";
import { buildMcpList } from "./mcp.js";
import { buildMarketplaceList } from "./marketplace.js";
import { buildCombinedPluginList, primeDeclarations } from "./plugins.js";
import { buildList, outputDir } from "./projects.js";
import { render } from "./views/render.js";
import { parseKey, handleKey, handleInputData, handlePluginInputData, handleMarketplaceAddInputData, handleMcpAddInputData, handleSearchData, handleTabInputData, handleConfigInputData, handleConfigActionArgsData, switchPluginSubPage } from "./input.js";
import { setActivitySeam, withLoaderCause } from "./activity-seam.js";
import { inputCause } from "./input-cause.js";
import type { CustomTab } from "./custom-tab.js";
import type { LoaderCapabilities } from "./app-capabilities.js";
import type { LoaderConfig, PluginEntry } from "./config.js";
import type { MenuAction } from "./provider-menu.js";

/** What one self-check reports. */
interface DoctorResult {
  /** Whether it passed. */
  passed: boolean;
  /** What it found, shown either way. */
  message: string;
}

/**
 * The handle an app extension reaches this process by.
 *
 * @remarks
 * A global, because an extension the host app loaded has no import path into the loader's own
 * bundle: it is a separate module graph in the same process.
 */
interface LoaderGlobalApi {
  /** Where this home keeps its clones. */
  getReposDir: () => string;
  /** Where deployed bundles go. */
  getPluginsDir: () => string;
  /** This home's root. */
  getConfigDir: () => string;
  /** Shows a message in the status line. */
  log: (msg: string) => void;
  /** Copies one built plugin file into the deployed plugins directory. */
  deployPlugin: (pluginName: string, sourcePath: string) => void;
  /** Removes one deployed plugin file. */
  removePluginFiles: (pluginName: string) => void;
}

// A stable global for an app extension that has no import path into this process.
(globalThis as typeof globalThis & { LoaderAPI?: LoaderGlobalApi }).LoaderAPI = {
  getReposDir: function() { return REPOS_DIR; },
  getPluginsDir: function() { return PLUGINS_DIR; },
  getConfigDir: function() { return CONFIG_DIR; },
  log: function(msg: string) { flash(msg); render(); },
  
  // Deploy a plugin binary/script to the active plugins directory
  deployPlugin: function(pluginName: string, sourcePath: string) {
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
  removePluginFiles: function(pluginName: string) {
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

    exec(CLI_CMD + " --version", { timeout: 15000 }, function(versionError: unknown, installedOut: string) {
      if (versionError) return;
      exec("npm view " + NPM_PKG + " version", { timeout: 20000 }, function(viewError: unknown, latestOut: string) {
        if (viewError) return;
        var installed = (installedOut || "").trim();
        var latest = (latestOut || "").trim();
        if (!latest || !installed || latest === installed) return;
        flash("Updating " + APP_NAME + " " + installed + " -> " + latest + " in the background");
        render();
        exec("npm install -g " + NPM_PKG + "@latest", { timeout: 180000 }, function(installError: Error | null) {
          tuiLog(installError ? "self-update failed: " + installError.message : "self-updated to " + latest);
          if (!installError) { flash(APP_NAME + " updated to " + latest + " (restart to apply)"); render(); }
        });
      });
    });
  } catch (e) { tuiLog("update check failed: " + (e instanceof Error ? e.message : e)); }
}

// deferred so the TUI renders immediately instead of waiting on version checks
if (autoUpdateCheck()) setTimeout(checkForUpdates, updateCheckDelayMs());


/**
 * What a plugin's `tui-extension.js` is handed to extend this terminal.
 *
 * @remarks
 * The extension exports a function; the loader calls it with this object. Everything a tab can do
 * to the loader it does through here, so a tab links nothing of the loader itself.
 */
export interface TuiApi {
  /** Adds a tab to the Plugins page, ignoring a second registration of the same id. */
  registerTab: (tab: CustomTab) => void;
  /** This home's pinned and hidden projects. */
  loadConfig: () => LoaderConfig;
  /** Writes them back. */
  saveConfig: (cfg: LoaderConfig) => void;
  /** The plugin list. */
  loadPlugins: () => PluginEntry[];
  /** Shows a message in the status line. */
  flash: (msg: string) => void;
  /** Routes raw text to the active tab instead of the loader's own key table, for a search box. */
  setTextInput: (on: boolean) => void;
  /** Redraws now, for work that finished off the keypress path. */
  refresh: () => void;
  /** Suspends the TUI, runs something that owns the terminal, then re-attaches input and redraws. */
  runBlocking: (fn: () => unknown) => unknown;
  /** Registers what the active loader can do, which is what gates every optional feature. */
  registerCapabilities: (caps: LoaderCapabilities) => void;
}

/** The handle every contributed tab reaches this loader through. */
export var tuiApi: TuiApi = {
  registerTab: function(tab: CustomTab) {
    if (tab && tab.id && tab.label && !S.customTabs.some(function(t) { return t.id === tab.id; })) {
      S.customTabs.push(tab);   // dedup by id so a double-load can't add the tab twice
    }
  },
  loadConfig: function() { return loadConfig(); },
  saveConfig: function(cfg: LoaderConfig) { return saveConfig(cfg); },
  loadPlugins: function() { return loadPlugins(); },
  flash: function(msg: string) { flash(msg); },
  // let a custom tab capture raw text (search boxes); routes keys to its handleKey
  setTextInput: function(on: boolean) { S.mode = on ? "tabinput" : "list"; },
  // redraw on demand (a tab finished async work off the keypress path, e.g. a
  // login input resolving or a loopback callback auto-completing)
  refresh: function() { render(); },
  // suspend the loader TUI, run a blocking raw-stdin routine (the shared account
  // menu), then re-attach input and redraw
  runBlocking: function(fn: () => unknown) { return runBlocking(fn); },
  registerCapabilities: function(caps: LoaderCapabilities) {
    if (caps && typeof caps === "object") {
      Object.assign(S.capabilities, caps);
      // The same object carries the read side the views use and the write side the
      // seam needs, so a loader wires Activity in one place.
      if (caps.activity) setActivitySeam(caps.activity);
    }
  }
};

function runBlocking(fn: () => unknown) {
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

async function loadCustomTabs() {
  S.customTabs = [];
  // Built in, but registered here so it survives the reset above and plugin tabs
  // append after it rather than in front of it.
  tuiApi.registerTab(librariesTab);
  const { pathToFileURL } = require("url");
  async function loadExt(extPath: string | undefined) {
    if (!extPath || !existsSync(extPath)) return;
    try {
      // tui-extension.js is an esbuild ESM bundle; require() throws under Node, so
      // import() it (via a file:// URL).
      var mod = await import(pathToFileURL(extPath).href);
      var fn = (mod && mod.default) || mod;
      // Await in case the extension's own async init (e.g. a bundled TeaVM module)
      // must resolve before the tab is usable; a sync-returning extension awaits
      // a non-promise value harmlessly.
      if (typeof fn === "function") await fn(tuiApi);
    } catch(e) { tuiLog("custom tab load failed (" + extPath + "): " + e); }
  }
  // 1. The active loader declares its own extension via env (absolute path)
  await loadExt(process.env.HUB_TUI_EXTENSION);
  // 2. Installed plugins may ship a tui-extension.js in their repo root
  try {
    var pl = loadPlugins();
    for (var i = 0; i < pl.length; i++) {
      await loadExt(join(REPOS_DIR, getFolderName(pl[i]), "tui-extension.js"));
    }
  } catch(e) {}
}

var { exec } = require("child_process");


S.items = buildList();

S.pluginItems = buildCombinedPluginList();

S.mcpItems = buildMcpList("All");
S.marketplaceItems = buildMarketplaceList();

process.on("exit", function() { showCur(); });
// Last line of defence for the asynchronous paths: without a handler Node terminates the process on
// an unhandled rejection, skipping cleanup() and leaving a half-drawn TUI under a stack trace.
process.on("unhandledRejection", function(reason) { tuiLog("unhandled rejection: " + String(reason), true); });
process.on("SIGINT", function() { cleanup(); process.exit(1); });
process.on("SIGTERM", function() { cleanup(); process.exit(1); });
try { process.stderr.on("resize", function() { render(); }); } catch(e) {}
try { process.stdout.on("resize", function() { render(); }); } catch(e) {}




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
      addTest: function(category: string, name: string, fn: () => DoctorResult | null) {
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
          console.log("\x1b[31m  [✗]\x1b[0m " + name + " (Error: " + (e instanceof Error ? e.message : e) + ")");
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
// Startup runs async because custom tabs (Providers) and the updater engine are ESM
// bundles that must be import()'d (require() throws under Node); await both BEFORE the
// first paint so the Providers tab shows and the engine isn't reported "missing".
async function boot() {
  await loadCustomTabs();
  // The module-load build of S.pluginItems (top of file) ran BEFORE loadCustomTabs
  // registered the app's capabilities, so it missed the host's own "App plugins"
  // (foreignPlugins). Rebuild now that capabilities are live so they show on first render.
  S.pluginItems = buildCombinedPluginList();
  if (process.env.HUB_OPEN_TAB) {
    S.page = "plugins";
    S.pluginSubPage = process.env.HUB_OPEN_TAB;
  } else {
    // honor the configured initial tab (validated; defaults to "projects" =
    // current behavior) only when the wrapper hasn't forced a tab via env
    S.page = defaultTab();
  }
  // disable any mouse reporting a previous program left enabled, pointer
  // movement otherwise arrives as input bytes and triggers random key handlers
  process.stderr.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l");
  await Promise.all([
    preloadUpdater().catch(function () {}),
    startPluginHost().then(function () {
      return Promise.all([refreshScreenSpecs(), primeDeclarations()]);
    }).catch(function () {}),
  ]);
  // Rebuilt once resolution has settled: the manager's own npm row is marked and versioned from
  // resolvedManager(), which answers nothing until preloadUpdater has run.
  S.pluginItems = buildCombinedPluginList();
  hideCur();
  render();
  // Guarded like every other raw-mode call here: boot() runs on import, and stdin
  // is not a TTY under a test runner, where the throw would surface as an
  // unhandled rejection and fail the run even with every test passing.
  try { process.stdin.setRawMode(true); } catch {}
  process.stdin.resume();
}
boot();


function onData(buf: Buffer) {
  var key = parseKey(buf);
  withLoaderCause(inputCause(S.page, S.mode, key), function () { dispatchInput(buf, key); });
}

function dispatchInput(buf: Buffer, key: string | null) {
  if (S.globalKeyHandler === "manager_recheck") {
    // The gate offers re-check-or-quit but must NOT trap the arrow keys: the other tabs need no
    // plugin manager. Everything else is swallowed so a stray key cannot act on the hidden list.
    if (key === "enter" || key === "space") {
      clearUpdaterCache();
      // The one surface that queries the marketplaces: the operator is asking what to install.
      preloadUpdater({ queryCapability: marketplaceQuery() }).catch(function () {}).then(function () {
        S.pluginItems = buildCombinedPluginList();
        render();
      });
      return;
    }
    if (key === "escape" || key === "q" || buf[0] === 3) process.exit(0);
    if (key !== "left" && key !== "right") return;
  }
  
  if (S.mode === "input") { handleInputData(buf); render(); return; }
  if (S.mode === "pinput") { handlePluginInputData(buf); render(); return; }
  if (S.mode === "mkinput") { handleMarketplaceAddInputData(buf); render(); return; }
  if (S.mode === "mcpaddinput") { handleMcpAddInputData(buf); render(); return; }
  if (S.mode === "pcfginput") { handleConfigInputData(buf); render(); return; }
  if (S.mode === "pcfgargs") { handleConfigActionArgsData(buf); render(); return; }
  if (S.mode === "search") { handleSearchData(buf); render(); return; }
  if (S.mode === "tabinput") { handleTabInputData(buf); render(); return; }
  if (key) {
    // Never let a handler error crash the whole TUI: surface it as a status
    // message and keep the loop alive so the user stays in their menu.
    try { handleKey(key); }
    catch (e) { try { flash("Error: " + (e instanceof Error ? e.message : e)); } catch (_) {} }
    render();
  }
}
process.stdin.on("data", onData);
