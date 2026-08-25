// @ts-nocheck
// Environment: app identity, filesystem paths, static catalogs, and the file
// logger. All values here are read-only constants shared across modules.

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { appPathNames } from "@intisy-ai/core";
import { detectAppId, registryDescriptor, resolveHome } from "./app-descriptor.js";

// A host that imports a plugin module for its API, rather than to activate it, says so here: a
// plugin manager runs its whole update sequence on import and logs to the console, which would
// print over this TUI. The generic key is the contract; the vendor-named one is set for a manager
// deployed before that key existed.
process.env.INTISY_PLUGIN_LIBRARY_MODE = "1";
process.env.PLUGIN_UPDATER_LIBRARY_MODE = "1";

export const HOME = homedir();
// Injected by the loader that owns this home, because which app this is belongs to that app's own
// project and not to this library. Empty when nothing injected it and nothing detects it, which is
// not an error: a consumer that needs the id degrades rather than guessing one.
export const APP_ID = (process.env.HUB_APP_ID || "").trim() || detectAppId();
const DESCRIPTOR = registryDescriptor(APP_ID);
export const APP_NAME = process.env.HUB_APP_NAME || DESCRIPTOR?.label || "";
export const CLI_CMD = process.env.HUB_CLI_CMD || DESCRIPTOR?.detect?.binary || "";
export const NPM_PKG = process.env.HUB_NPM_PKG || DESCRIPTOR?.detect?.pkg || "";
export const CONFIG_DIR = process.env.HUB_CONFIG_DIR || (DESCRIPTOR ? resolveHome(DESCRIPTOR) : "");

const SUBDIRS = appPathNames(DESCRIPTOR);
export const REPOS_SUBDIR = SUBDIRS.repos;
export const PLUGIN_SUBDIR = SUBDIRS.plugin;
export const CACHE_SUBDIR = SUBDIRS.cache;
export const CONFIG_SUBDIR = SUBDIRS.config;

// Every home-relative path goes through here: `join("", "config")` yields the RELATIVE "config",
// so an unknown app would read and write into whatever directory the process was launched from.
function underHome(...segments) {
  return CONFIG_DIR ? join(CONFIG_DIR, ...segments) : "";
}

export const CACHE_PKG_DIR = underHome(CACHE_SUBDIR, "node_modules");

export const CONFIG_FOLDER = underHome(CONFIG_SUBDIR);
export const CACHE_DIR = underHome(CACHE_SUBDIR);
export const CONFIG_PATH = underHome(CONFIG_SUBDIR, "oc-config.json");
export const UPDATE_CHECK_PATH = underHome(CACHE_SUBDIR, "oc-last-update-check");
export const PLUGINS_JSON = underHome(CONFIG_SUBDIR, "plugins.json");
export const REPOS_DIR = underHome(REPOS_SUBDIR);
export const PLUGINS_DIR = underHome(PLUGIN_SUBDIR);
export const MCP_CONFIG_PATH = underHome(".mcp.json");
export const CATALOG_CACHE_PATH = underHome(CACHE_SUBDIR, "marketplace-catalog.json");
export const SEED_CACHE_PATH = underHome(CACHE_SUBDIR, "seed-marketplaces.json");

// anything printed to the terminal corrupts the TUI, diagnostics go to a file
export const TUI_START_TIME = new Date().toISOString().replace(/:/g, "-").split(".")[0];
// isError just tags the line for grep-ability -- never mirrored to stderr (see above).
export function tuiLog(msg, isError?) {
  try {
    if (!CONFIG_DIR) return;
    var dateStr = new Date().toISOString().split("T")[0];
    var logsDir = join(CONFIG_DIR, "logs", dateStr);
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    require("fs").appendFileSync(join(logsDir, "loader-tui-" + TUI_START_TIME + ".log"),
      "[" + new Date().toISOString() + "]" + (isError ? " [ERROR]" : "") + " " + msg + "\n");
  } catch {}
}

export { MCP_CATALOG, CURATED_MCP_REPOS, DEFAULT_MARKETPLACES, FEATURED_PLUGINS, MARKETPLACE_MANIFEST_PATH } from "./catalogs.js";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const HELP_BINDINGS = {
  projects: [
    ["^v / WS", "Move"], ["Enter / Space", "Open actions"], ["O", "Open project"],
    ["P", "Pin / unpin"], ["H", "Hide project"], ["U", "Unhide all"],
    ["C", "Open custom path"], ["<- ->", "Switch page"], ["Q / Esc", "Quit"],
  ],
  plugins: [
    ["^v / WS", "Move"], ["Enter", "Plugin actions / open marketplace"], ["Tab", "Installed / Marketplace / Providers"],
    ["F", "Check for updates"], ["R", "Refresh list / catalog"], ["U", "Update selected"],
    ["A", "Update all"], ["D", "Disable selected"], ["I", "Quick install (marketplace)"],
    ["/", "Search (marketplace)"], ["[ / ]", "Jump group (marketplace)"], ["Esc", "Back out of a marketplace"],
    ["R", "Reveal a secret value (Configure editor only)"],
    ["<- ->", "Switch page"], ["Q", "Quit"],
  ],
  mcp: [
    ["^v / WS", "Move"], ["Enter", "Server actions"], ["Tab", "Installed / Marketplace"],
    ["I", "Install selected"], ["X", "Uninstall selected"], ["R", "Refresh catalog"],
    ["/", "Search"], ["<- ->", "Switch page"], ["Q / Esc", "Quit"],
  ],
  settings: [
    ["^v / WS", "Move"], ["Enter", "Open a group / edit a setting"],
    ["Tab", "Switch sub-tab (Settings / contributed screens)"],
    ["R", "Reveal a secret value (Configure editor only)"],
    ["<- ->", "Switch page"], ["Q / Esc", "Quit"],
  ],
};
