// @ts-nocheck
// Non-interactive loader CLI (`cc|oc <plugins|providers|proxy|doctor>`); runs under
// node so the wrapper can dispatch here without bun. Mutations drive plugin-updater
// via transient npx, never a persistent require.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import {
  APP_NAME,
  CLI_CMD,
  CONFIG_FOLDER,
  PLUGINS_JSON,
  REPOS_DIR,
  PLUGINS_DIR,
} from "./env.js";
import { readDeployedProviders } from "./loader-runtime.js";

const PROXY_PORT = parseInt(process.env.HUB_PROXY_PORT || "34567", 10);
const PROXY_URL = "http://127.0.0.1:" + PROXY_PORT;
const UPDATER_APP = /claude/i.test(APP_NAME) || /claude/i.test(CLI_CMD) ? "claude" : "opencode";
const ACCOUNTS_JSON = join(CONFIG_FOLDER, "accounts.json");
const LOADER_CONFIG = join(CONFIG_FOLDER, UPDATER_APP === "claude" ? "claude-code-loader.json" : "opencode-loader.json");

const OK = "✓";
const BAD = "✗";

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function pad(str, width) {
  str = String(str);
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

// ---- plugins -------------------------------------------------------------

function loadPluginEntries() {
  const entries = readJson(PLUGINS_JSON);
  return Array.isArray(entries) ? entries : [];
}

function pluginsList() {
  const entries = loadPluginEntries();
  if (!entries.length) {
    console.log("No plugins registered (config/plugins.json is empty).");
    return;
  }
  console.log("Plugins (" + entries.length + ") — " + UPDATER_APP + ":\n");
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

function runUpdater(args) {
  const full = ["-y", "plugin-updater@latest"].concat(args, ["--app", UPDATER_APP]);
  console.log("$ npx " + full.join(" ") + "\n");
  execFileSync("npx", full, { stdio: "inherit" });
}

function pluginsInstall(url) {
  if (!url) { console.error("usage: plugins install <git-url>"); process.exit(1); }
  runUpdater(["add", url]);
}

function pluginsUpdate(name) {
  // plugin-updater's `run` refreshes every plugin; there is no single-plugin verb.
  if (name) console.log("(updating all plugins; per-plugin update is not a separate operation)\n");
  runUpdater(["run"]);
}

// ---- providers -----------------------------------------------------------

function accountsByProvider() {
  const store = readJson(ACCOUNTS_JSON);
  const providers = (store && store.providers) || {};
  const out = {};
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
  const cfg = readJson(LOADER_CONFIG);
  const map = (cfg && cfg.modelMap) || {};
  const out = {};
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

  console.log("Providers — " + UPDATER_APP + ":\n");
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

async function probeProxy(timeoutMs) {
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
  if (!up) console.log("  Start it by launching `" + (UPDATER_APP === "claude" ? "cc" : "oc") + "` (the wrapper starts the daemon).");
}

// ---- doctor --------------------------------------------------------------

function wrapperState() {
  const bin = join(process.env.HOME || process.env.USERPROFILE || "", ".local", "bin", UPDATER_APP === "claude" ? "cc" : "oc");
  if (!existsSync(bin)) return { installed: false };
  const text = readFileSync(bin, "utf8");
  return { installed: true, routesViaToken: text.includes("ANTHROPIC_AUTH_TOKEN") };
}

function hasNpx() {
  try { execFileSync("npx", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

async function doctor() {
  console.log("doctor — " + APP_NAME + "\n");

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

  console.log("  " + pad("plugin-updater (npx)", 26) + (hasNpx() ? "npx available " + OK : "npx MISSING " + BAD));
}

// ---- dispatch ------------------------------------------------------------

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case "plugins": {
      const op = rest[0];
      if (op === "list" || op === undefined) return pluginsList();
      if (op === "install") return pluginsInstall(rest[1]);
      if (op === "update") return pluginsUpdate(rest[1]);
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
      console.log("usage: " + (UPDATER_APP === "claude" ? "cc" : "oc") + " <plugins|providers|proxy|doctor>");
      console.log("  plugins list | install <git-url> | update [name]");
      console.log("  providers            list providers, accounts, and tier mapping");
      console.log("  proxy status         check the loader proxy daemon");
      console.log("  doctor               aggregate health check");
      if (sub) process.exit(1);
  }
}

main().catch((error) => { console.error(String((error && error.message) || error)); process.exit(1); });
