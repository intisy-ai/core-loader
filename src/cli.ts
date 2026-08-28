// Non-interactive loader CLI (`cc|oc <plugins|providers|proxy|doctor>`); runs under
// node so the wrapper can dispatch here without bun. Mutations run through the
// plugin manager this home resolved, never npx.

import { existsSync, readFileSync } from "fs";
import { readJson } from "./json.js";
import { join } from "path";
import {
  APP_ID,
  APP_NAME,
  CLI_CMD,
  CONFIG_DIR,
  CONFIG_FOLDER,
  PLUGINS_JSON,
  REPOS_DIR,
  PLUGINS_DIR,
} from "./env.js";
import { appWrapperCommand } from "./app-descriptor.js";
import { readDeployedProviders } from "./loader-runtime.js";
import { getUpdater, managerBootstrapCommand, preloadUpdater, resolvedManager, setupPlugin } from "./updater.js";
import { loaderConfigName, registerPlugin } from "./config.js";
import type { PluginEntry } from "./config.js";

/** One account of one provider, as the doctor and provider views list it. */
interface AccountSummary {
  /** What identifies it to a reader: its id, or the address it was signed in with. */
  id: string;
  /** Whether it is in use. */
  enabled: boolean;
  /** Whether it is waiting out a rate limit. */
  coolingDown: boolean;
}

/** The account store, as far as this CLI reads it. */
interface AccountStoreFile {
  /** Each provider's accounts, by provider name. */
  providers?: Record<string, { accounts?: Array<{ id?: string; email?: string; enabled?: boolean; coolingDownUntil?: number }> }>;
}

/** The part of the loader's own config this CLI reads: which provider serves each tier. */
interface LoaderRoutingConfig {
  /** Each tier's chosen provider, by tier name. */
  modelMap?: Record<string, { provider?: string }>;
}

const PROXY_PORT = parseInt(process.env.HUB_PROXY_PORT || "34567", 10);
const PROXY_URL = "http://127.0.0.1:" + PROXY_PORT;
const UPDATER_APP = APP_ID;
const ACCOUNTS_JSON = join(CONFIG_FOLDER, "accounts.json");
const LOADER_CONFIG = join(CONFIG_FOLDER, loaderConfigName() + ".json");
// The wrapper's own name is app-specific data (e.g. "cc"/"oc"), declared beside the app's other
// traits; an app that declares none is launched by its own binary instead.
const WRAPPER_CMD = appWrapperCommand() || CLI_CMD;

const OK = "✓";
const BAD = "✗";

function pad(str: string | number, width: number): string {
  str = String(str);
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

// ---- plugins -------------------------------------------------------------

function loadPluginEntries() {
  const entries = readJson<PluginEntry[]>(PLUGINS_JSON);
  return Array.isArray(entries) ? entries : [];
}

function pluginsList() {
  const entries = loadPluginEntries();
  if (!entries.length) {
    console.log("No plugins registered (config/plugins.json is empty).");
    return;
  }
  console.log("Plugins (" + entries.length + ") - " + UPDATER_APP + ":\n");
  console.log("  " + pad("NAME", 22) + pad("STATE", 12) + pad("DEPLOYED", 10) + "AUTO-UPDATE");
  for (const entry of entries) {
    const name = entry.name || "?";
    const enabled = entry.enabled !== false;
    const deployed = existsSync(join(PLUGINS_DIR, (entry.pluginFile || name + ".js")));
    const cloned = existsSync(join(REPOS_DIR, name));
    const state = !enabled ? "disabled" : cloned ? "installed" : "not cloned";
    console.log(
      "  " + pad(name, 22) + pad(state, 12) +
      pad(deployed ? OK : BAD, 10) + (entry.autoUpdate === false ? "manual" : "auto"),
    );
  }
}

// Mutations run through the plugin manager this home resolved. npx is never used: it would fetch the
// published package rather than run what this home installed.
async function withManager() {
  await preloadUpdater();
  const manager = getUpdater();
  if (manager) return manager;
  console.error("No plugin in this home declares the plugin-management capability, so plugins cannot be installed or updated from here.");
  const command = managerBootstrapCommand();
  if (command) console.error("Install one yourself with: " + command);
  process.exit(1);
}

async function pluginsInstall(url: string): Promise<void> {
  if (!url) { console.error("usage: plugins install <git-url>"); process.exit(1); }
  await withManager();
  const name = String(url).replace(/\.git$/, "").split("/").pop() || url;
  registerPlugin(name, url);
  console.log("Installing " + name + " ...");
  const failure = await new Promise<string>((resolve) => setupPlugin({ name: name, url: url }, resolve));
  if (failure) { console.error(name + ": " + failure); process.exit(1); }
  console.log(name + " installed.");
}

async function pluginsUpdate(name: string): Promise<void> {
  const manager = await withManager();
  if (name) {
    if (typeof manager.updateOne !== "function") {
      console.error("the installed plugin manager offers no updateOne");
      process.exit(1);
    }
    await manager.updateOne(CONFIG_DIR, name);
  } else {
    if (typeof manager.updateAll !== "function") {
      console.error("the installed plugin manager offers no updateAll");
      process.exit(1);
    }
    await manager.updateAll(CONFIG_DIR);
  }
  console.log(name ? (name + " updated.") : "All plugins updated.");
}

// ---- providers -----------------------------------------------------------

function accountsByProvider() {
  const store = readJson<AccountStoreFile>(ACCOUNTS_JSON);
  const providers = (store && store.providers) || {};
  const out: Record<string, AccountSummary[]> = {};
  for (const name of Object.keys(providers)) {
    const accounts = (providers[name] && providers[name].accounts) || [];
    out[name] = accounts.map((a) => ({
      id: a.id || a.email || "?",
      enabled: a.enabled !== false,
      coolingDown: !!(a.coolingDownUntil && a.coolingDownUntil > Date.now()),
    }));
  }
  return out;
}

function deployedHandlers() {
  return readDeployedProviders(REPOS_DIR).map((provider) => ({
    provider: provider.provider,
    repo: provider.repo,
    present: existsSync(provider.handlerPath),
  }));
}

function tiersByProvider() {
  const cfg = readJson<LoaderRoutingConfig>(LOADER_CONFIG);
  const map = (cfg && cfg.modelMap) || {};
  const out: Record<string, string[]> = {};
  for (const tier of Object.keys(map)) {
    const provider = map[tier] && map[tier].provider;
    if (!provider) continue;
    (out[provider] = out[provider] || []).push(tier);
  }
  return out;
}

function providers() {
  const accounts = accountsByProvider();
  const tiers = tiersByProvider();
  const handlers = deployedHandlers();

  console.log("Providers - " + UPDATER_APP + ":\n");
  const names = new Set([...Object.keys(accounts), ...Object.keys(tiers)]);
  if (!names.size) {
    console.log("  (no accounts and no model mapping configured)");
  }
  for (const name of names) {
    const list = accounts[name] || [];
    const ids = list.map((a) => a.id + (a.enabled ? "" : " [disabled]") + (a.coolingDown ? " [cooling]" : ""));
    console.log("  " + pad(name, 18) + list.length + (list.length === 1 ? " account" : " accounts") +
      (ids.length ? "   [" + ids.join(", ") + "]" : ""));
    const assigned = tiers[name];
    if (assigned && assigned.length) console.log("    tiers: " + assigned.join(", "));
  }

  console.log("\nDeployed provider handlers (repos/):");
  if (!handlers.length) console.log("  (none)");
  for (const handler of handlers) {
    console.log("  " + pad(handler.provider, 18) + "-> " + handler.repo + "  " + (handler.present ? OK : BAD));
  }
}

// ---- proxy ---------------------------------------------------------------

async function probeProxy(timeoutMs?: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 1500);
  try {
    const res = await fetch(PROXY_URL + "/health", { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function proxyStatus() {
  const up = await probeProxy(2000);
  console.log("Proxy (" + PROXY_URL + "): " + (up ? "UP " + OK : "DOWN " + BAD));
  if (!up) console.log("  Start it by launching `" + WRAPPER_CMD + "` (the wrapper starts the daemon).");
}

// ---- doctor --------------------------------------------------------------

function wrapperState() {
  // An empty WRAPPER_CMD would collapse the join to the bin DIRECTORY itself, and reading that
  // throws EISDIR rather than answering "not installed".
  if (!WRAPPER_CMD) return { installed: false };
  const bin = join(process.env.HOME || process.env.USERPROFILE || "", ".local", "bin", WRAPPER_CMD);
  if (!existsSync(bin)) return { installed: false };
  const text = readFileSync(bin, "utf8");
  return { installed: true, routesViaToken: text.includes("ANTHROPIC_AUTH_TOKEN") };
}

async function doctor() {
  console.log("doctor - " + APP_NAME + "\n");

  const up = await probeProxy(2000);
  console.log("  " + pad("proxy (:" + PROXY_PORT + ")", 26) + (up ? "UP " + OK : "DOWN " + BAD));

  const wrapper = wrapperState();
  console.log("  " + pad("wrapper", 26) +
    (!wrapper.installed ? "not installed " + BAD
      : wrapper.routesViaToken ? "installed, routes via ANTHROPIC_AUTH_TOKEN " + OK
        : "installed but NOT routing via token " + BAD));

  const handlers = deployedHandlers();
  const present = handlers.filter((h) => h.present);
  console.log("  " + pad("provider handlers", 26) + present.length + " deployed" +
    (present.length ? " (" + present.map((h) => h.provider).join(", ") + ")" : " " + BAD));

  const accounts = accountsByProvider();
  const total = Object.values(accounts).reduce((sum, list) => sum + list.length, 0);
  const breakdown = Object.keys(accounts).map((name) => name + ": " + accounts[name].length).join(", ");
  console.log("  " + pad("accounts", 26) + total + (breakdown ? " (" + breakdown + ")" : "") + (total ? " " + OK : " " + BAD));

  const entries = loadPluginEntries();
  const deployed = entries.filter((entry) => existsSync(join(PLUGINS_DIR, (entry.pluginFile || entry.name + ".js"))));
  console.log("  " + pad("plugins.json", 26) + entries.length + " entries, " + deployed.length + " deployed");

  await preloadUpdater();
  const manager = resolvedManager();
  console.log("  " + pad("plugin manager", 26) + (manager ? manager.id + " (" + manager.source + ") " + OK : "none installed " + BAD));
}

// ---- dispatch ------------------------------------------------------------

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case "plugins": {
      const op = rest[0];
      if (op === "list" || op === undefined) return pluginsList();
      if (op === "install") return await pluginsInstall(rest[1]);
      if (op === "update") return await pluginsUpdate(rest[1]);
      console.error("usage: plugins <list|install <url>|update [name]>");
      process.exit(1);
      break;
    }
    case "providers":
      return providers();
    case "proxy":
      if (rest[0] && rest[0] !== "status") { console.error("usage: proxy status"); process.exit(1); }
      return proxyStatus();
    case "doctor":
      return doctor();
    default:
      console.log("usage: " + WRAPPER_CMD + " <plugins|providers|proxy|doctor>");
      console.log("  plugins list | install <git-url> | update [name]");
      console.log("  providers            list providers, accounts, and tier mapping");
      console.log("  proxy status         check the loader proxy daemon");
      console.log("  doctor               aggregate health check");
      if (sub) process.exit(1);
  }
}

main().catch((error) => { console.error(String((error && error.message) || error)); process.exit(1); });
