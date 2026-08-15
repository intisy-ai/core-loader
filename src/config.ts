// @ts-nocheck
// Read/write for loader config, the plugins list, and the MCP server config.
// All three prefer the config/ subdir and fall back to legacy top-level files.

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, unlinkSync } from "fs";
import { readJson } from "./json.js";
import { join, dirname } from "path";
import { CONFIG_PATH, CONFIG_FOLDER, CONFIG_DIR, APP_ID, REPOS_DIR, PLUGINS_JSON, MCP_CONFIG_PATH } from "./env.js";
import { appOfClone } from "./clone-app.js";
import { loaderIdOfHome } from "./app-descriptor.js";

// ── The active loader's own plugin config (config/<loader id>.json) ─────────
// The same file the loader's plugin.ts registers via defineConfig; the TUI reads it for the
// runtime knobs below. Returns {} when no file exists, so every getter falls back to the default
// that reproduces current behavior.
var LOADER_CONFIG = null;

/**
 * The id of the loader whose config this home holds.
 *
 * @remarks
 * Discovered rather than injected or named: a home holds exactly one clone whose `cairn.json`
 * declares an app, and that clone is this app's loader. An injected id defaulting to nothing would
 * make a real home read its loader's knobs as defaults until every loader injects it.
 */
export function loaderConfigName() {
  return loaderIdOfHome();
}

export function loadLoaderConfig() {
  if (LOADER_CONFIG !== null) return LOADER_CONFIG;
  var name = loaderConfigName();
  if (!name) return (LOADER_CONFIG = {});
  var preferred = join(CONFIG_FOLDER, name + ".json");
  var fallback = join(CONFIG_DIR, name + ".json");
  var p = existsSync(preferred) ? preferred : existsSync(fallback) ? fallback : null;
  LOADER_CONFIG = p ? readJson(p, {}) : {};
  return LOADER_CONFIG;
}

// Getters with defaults that reproduce CURRENT behavior exactly when unset.
function num(v, fallback) {
  var n = Number(v);
  return (v != null && !isNaN(n)) ? n : fallback;
}

export function autoUpdateCheck() {
  return loadLoaderConfig().auto_update_check !== false;   // default true
}
export function updateCheckDelayMs() {
  return num(loadLoaderConfig().update_check_delay_ms, 1500);
}
export function updateCheckIntervalHours() {
  return num(loadLoaderConfig().update_check_interval_hours, 24);
}
export function catalogCacheHours() {
  return num(loadLoaderConfig().catalog_cache_hours, 6);
}
export function defaultTab() {
  var t = loadLoaderConfig().default_tab;
  // validate against the real page names; fall back to "projects" if invalid
  return (t === "projects" || t === "plugins" || t === "mcp" || t === "settings") ? t : "projects";
}

export function loadConfig() {
  var current = readJson(CONFIG_PATH);
  if (current) return current;
  var legacy = readJson(join(CONFIG_DIR, "oc-config.json"));
  if (legacy) return legacy;
  return { pinned: [], hidden: [] };
}

export function saveConfig(cfg) {
  try {
    if (!existsSync(CONFIG_FOLDER)) mkdirSync(CONFIG_FOLDER, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch {}
}

// ── Global ecosystem settings (config/settings.json) ────────────────────────
// The shared, app-wide settings every plugin reads via core's globalSetting(). The
// loader edits this file DIRECTLY (plain JSON, like plugins.json) so the Configure
// editor can manage global settings with no plugin bundle / no agent. These defaults are
// the FALLBACK: the host loader injects core's own declaration (see buildGlobalSection),
// which is authoritative and carries field types.
var GLOBAL_SETTINGS_FILE = join(CONFIG_FOLDER, "settings.json");
export var GLOBAL_SETTINGS_DEFAULTS = { logConsole: false, logColor: true };

// Cached parsed settings so a navigation render (buildSettings reads these every
// frame) never re-reads settings.json from disk. Invalidated when setGlobalSetting writes.
var GLOBAL_SETTINGS_CACHE = null;

export function loadGlobalSettings() {
  if (GLOBAL_SETTINGS_CACHE !== null) return GLOBAL_SETTINGS_CACHE;
  var out = readJson(GLOBAL_SETTINGS_FILE, {});
  GLOBAL_SETTINGS_CACHE = out;
  return out;
}

// parse a CLI/edit string into the obvious type (mirrors core's coerce)
function coerceGlobal(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (v !== "" && !isNaN(Number(v))) return Number(v);
  if (/^[[{]/.test(String(v).trim())) { try { return JSON.parse(v); } catch {} }
  return v;
}

export function setGlobalSetting(key, valueStr) {
  try {
    var cur = loadGlobalSettings();
    cur[key] = coerceGlobal(valueStr);
    if (!existsSync(CONFIG_FOLDER)) mkdirSync(CONFIG_FOLDER, { recursive: true });
    writeFileSync(GLOBAL_SETTINGS_FILE, JSON.stringify(cur, null, 2));
    GLOBAL_SETTINGS_CACHE = null;   // next read reflects the write
    return "";
  } catch (e) { return (e && e.message) || "set failed"; }
}

export function migrateConfigs() {
  if (!existsSync(CONFIG_FOLDER)) try { mkdirSync(CONFIG_FOLDER, { recursive: true }); } catch {}
  var legacyConfig = join(CONFIG_DIR, "oc-config.json");
  if (existsSync(legacyConfig) && !existsSync(CONFIG_PATH)) {
    try { copyFileSync(legacyConfig, CONFIG_PATH); } catch {}
  }
  var legacyPlugins = join(CONFIG_DIR, "plugins.json");
  if (existsSync(legacyPlugins) && !existsSync(PLUGINS_JSON)) {
    try { copyFileSync(legacyPlugins, PLUGINS_JSON); try { unlinkSync(legacyPlugins); } catch {} } catch {}
  }
}

export function loadPlugins() {
  // Read the plugin list DIRECTLY from plugins.json, the single source of truth the
  // plugin manager itself reads and writes, and exactly how the non-interactive
  // `cc plugins` / `cc doctor` CLI reads it. Routing this through the loaded updater
  // module's getPlugins() indirection has returned empty in some setups even though
  // the file was present and readable, so the file itself is the reliable source.
  //
  // This does NOT hide a missing plugin manager: detecting one is a separate concern handled by
  // buildPlugins, which gates the whole tab on getUpdater() and shows the re-check gate when none
  // is loadable. So this only ever populates the list once a manager is already detected.
  try {
    var fs = require("fs");
    var candidates = [PLUGINS_JSON, join(CONFIG_DIR, "plugins.json")];
    for (var i = 0; i < candidates.length; i++) {
      if (fs.existsSync(candidates[i])) {
        var arr = JSON.parse(fs.readFileSync(candidates[i], "utf-8"));
        if (Array.isArray(arr)) {
          // Another app's loader is a plugin of that app's home, never an entry to offer here.
          return arr.filter(function (e) {
            if (!e) return false;
            if (!APP_ID) return true;
            var declaredApp = appOfClone(REPOS_DIR, e.name);
            return declaredApp === null || declaredApp === APP_ID;
          });
        }
      }
    }
  } catch {}
  return [];
}

export function savePlugins(plugins) {
  if (!existsSync(CONFIG_FOLDER)) try { mkdirSync(CONFIG_FOLDER, { recursive: true }); } catch {}
  // config/ is always preferred; the top-level file only when config/ cannot exist
  var target = existsSync(CONFIG_FOLDER) ? PLUGINS_JSON : join(CONFIG_DIR, "plugins.json");
  writeFileSync(target, JSON.stringify(plugins, null, 2), "utf-8");
}

/**
 * Registers a plugin in plugins.json unless it is already listed, answering whether it wrote.
 *
 * @remarks
 * Reads the file directly rather than through `loadPlugins`, which hides the other app's loader:
 * writing that filtered list back would delete an entry the user never touched.
 */
export function registerPlugin(name, url) {
  var file = existsSync(PLUGINS_JSON) ? PLUGINS_JSON : join(CONFIG_DIR, "plugins.json");
  var listed = readJson(file, []);
  if (!Array.isArray(listed)) listed = [];
  if (listed.some(function (entry) { return entry && entry.name === name; })) return false;
  listed.push({ name: name, url: url, enabled: true, autoUpdate: true });
  savePlugins(listed);
  return true;
}

// Cached parsed MCP config so the MCP views (which read it every render) never hit
// disk during navigation. Invalidated when saveMcpConfig writes.
var MCP_CONFIG_CACHE = null;

export function loadMcpConfig() {
  if (MCP_CONFIG_CACHE !== null) return MCP_CONFIG_CACHE;
  var out = readJson(MCP_CONFIG_PATH, { mcpServers: {} });
  MCP_CONFIG_CACHE = out;
  return out;
}

export function saveMcpConfig(config) {
  try {
    if (!existsSync(dirname(MCP_CONFIG_PATH))) mkdirSync(dirname(MCP_CONFIG_PATH), { recursive: true });
    writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    MCP_CONFIG_CACHE = null;   // next read reflects the write
  } catch {}
}
