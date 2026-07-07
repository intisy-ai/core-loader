// @ts-nocheck
// Read/write for loader config, the plugins list, and the MCP server config.
// All three prefer the config/ subdir and fall back to legacy top-level files.

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { CONFIG_PATH, CONFIG_FOLDER, CONFIG_DIR, CLI_CMD, PLUGINS_JSON, MCP_CONFIG_PATH } from "./env.js";
import { getUpdater } from "./updater.js";

// ── Loader plugin config (config/<loaderName>.json) ─────────────────────────
// The active loader's OWN plugin config — the same file the loader's plugin.ts
// registers via defineConfig (opencode-loader.json / claude-code-loader.json).
// The TUI reads it for the runtime knobs below. Returns {} when no file exists,
// so every getter falls back to the default that reproduces current behavior.
//
// Loader name is derived from CLI_CMD (HUB_CLI_CMD) which the wrapper always
// sets: "opencode" -> opencode-loader, "claude" -> claude-code-loader. When the
// env is ambiguous (CLI_CMD unrecognized), fall back to whichever of the two
// config files actually exists on disk.
var LOADER_CONFIG = null;

function loaderName() {
  var cmd = String(CLI_CMD || "");
  if (cmd.indexOf("opencode") !== -1) return "opencode-loader";
  if (cmd.indexOf("claude") !== -1) return "claude-code-loader";
  // ambiguous: pick the loader whose config file exists (preferred then fallback)
  var candidates = ["opencode-loader", "claude-code-loader"];
  for (var i = 0; i < candidates.length; i++) {
    if (existsSync(join(CONFIG_FOLDER, candidates[i] + ".json"))) return candidates[i];
    if (existsSync(join(CONFIG_DIR, candidates[i] + ".json"))) return candidates[i];
  }
  return "opencode-loader";
}

export function loadLoaderConfig() {
  if (LOADER_CONFIG !== null) return LOADER_CONFIG;
  var name = loaderName();
  var preferred = join(CONFIG_FOLDER, name + ".json");
  var fallback = join(CONFIG_DIR, name + ".json");
  try {
    var p = existsSync(preferred) ? preferred : existsSync(fallback) ? fallback : null;
    LOADER_CONFIG = p ? (JSON.parse(readFileSync(p, "utf-8")) || {}) : {};
  } catch { LOADER_CONFIG = {}; }
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
  try { if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")); } catch {}
  var legacy = join(CONFIG_DIR, "oc-config.json");
  try { if (existsSync(legacy)) return JSON.parse(readFileSync(legacy, "utf-8")); } catch {}
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
// editor can manage global settings with no plugin bundle / no agent. Defaults mirror
// core's GLOBAL_SETTINGS_DEFAULTS — keep in sync if core adds global keys.
var GLOBAL_SETTINGS_FILE = join(CONFIG_FOLDER, "settings.json");
export var GLOBAL_SETTINGS_DEFAULTS = { logConsole: false, logColor: true };

// Cached parsed settings so a navigation render (buildSettings reads these every
// frame) never re-reads settings.json from disk. Invalidated when setGlobalSetting writes.
var GLOBAL_SETTINGS_CACHE = null;

export function loadGlobalSettings() {
  if (GLOBAL_SETTINGS_CACHE !== null) return GLOBAL_SETTINGS_CACHE;
  var out = {};
  try { if (existsSync(GLOBAL_SETTINGS_FILE)) out = JSON.parse(readFileSync(GLOBAL_SETTINGS_FILE, "utf-8")) || {}; } catch {}
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
  // The plugin list comes ONLY from the plugin-updater API — NO direct plugins.json
  // fallback. Without a detected updater there is no way to act on plugins, so the list
  // stays empty and the Plugins tab shows the install-updater prompt (a direct read
  // would hide a detection failure). If the updater isn't detected, fix DETECTION
  // (preloadUpdater / candidate paths), don't paper over it here.
  var updater = getUpdater();
  if (updater && typeof updater.getPlugins === "function") {
    try { return updater.getPlugins(CONFIG_DIR) || []; } catch {}
  }
  return [];
}

export function savePlugins(plugins) {
  if (!existsSync(CONFIG_FOLDER)) try { mkdirSync(CONFIG_FOLDER, { recursive: true }); } catch {}
  // config/ is always preferred; the top-level file only when config/ cannot exist
  var target = existsSync(CONFIG_FOLDER) ? PLUGINS_JSON : join(CONFIG_DIR, "plugins.json");
  writeFileSync(target, JSON.stringify(plugins, null, 2), "utf-8");
}

// Cached parsed MCP config so the MCP views (which read it every render) never hit
// disk during navigation. Invalidated when saveMcpConfig writes.
var MCP_CONFIG_CACHE = null;

export function loadMcpConfig() {
  if (MCP_CONFIG_CACHE !== null) return MCP_CONFIG_CACHE;
  var out = { mcpServers: {} };
  try {
    if (existsSync(MCP_CONFIG_PATH)) out = JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf-8"));
  } catch {}
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
