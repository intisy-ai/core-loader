// MCP server catalog, install/uninstall, and the per-server action menu.
// Merges the curated MCP_CATALOG with plugin-embedded .mcp.json servers.

import { existsSync, readdirSync, readFileSync } from "fs";
import { readJson } from "./json.js";
import { join } from "path";
import { MCP_CATALOG } from "./env.js";
import { loadMcpConfig, saveMcpConfig } from "./config.js";
import { fetchCatalogsAsync } from "./marketplace.js";
import { S } from "./state.js";
import { appDescriptors, resolveHome } from "./app-descriptor.js";
import { homePaths } from "./home-paths.js";
import type { ActionRow } from "./action-row.js";

/** One MCP server a plugin ships inside its own clone. */
export interface EmbeddedMcpServer {
  /** The command that starts it. */
  command?: string;
  /** That command's arguments. */
  args?: string[];
  /** The environment it needs. */
  env?: Record<string, string>;
  /** The plugin it ships inside. */
  pluginSource?: string;
}

/**
 * What the embedded-MCP scan found.
 *
 * @remarks
 * Two maps rather than one, because the names are keyed differently: a server is keyed
 * `plugin:<repo>:<server>` so two plugins can ship the same server, while the catalog only needs
 * the bare name to mark a row installed.
 */
export interface EmbeddedMcpScan {
  /** Each embedded server, by its `plugin:<repo>:<server>` key. */
  servers: Record<string, EmbeddedMcpServer>;
  /** The bare server names those keys carry. */
  baseMcpNames: Record<string, boolean>;
}

/**
 * One row of the MCP list, whether it is catalogued, embedded in a plugin, or already configured.
 *
 * @remarks
 * Like the marketplace list, the synthetic "add" row shares this array so the cursor indexes
 * straight into it.
 */
export interface McpRow {
  /** The server's name. */
  name: string;
  /** One line about what it does. */
  desc?: string;
  /** The command that starts it. */
  command?: string;
  /** That command's arguments. */
  args?: string[];
  /** The environment it needs, usually the API keys. */
  env?: Record<string, string>;
  /** The heading it is grouped under. */
  category?: string;
  /** Whether this home already has it. */
  installed?: boolean;
  /** Its GitHub star count, which is what the list is ranked by. */
  stars?: number;
  /** Whether it is a curated entry awaiting star enrichment. */
  curated?: boolean;
  /** The repository's `owner/name`. */
  full_name?: string;
  /** Whether it ships inside a plugin rather than being configured here. */
  embedded?: boolean;
  /** The plugin it ships inside. */
  pluginSource?: string;
  /** How it is reached, for a server the host app reported. */
  transport?: string;
  /** The URL or command shown beside the name, for a server the host app reported. */
  detail?: string;
  /** Whether the host app reported it rather than this loader reading the config file. */
  fromCapability?: boolean;
  /** Whether this row runs an action instead of opening something. */
  isAction?: boolean;
  /** Which action it runs. */
  actionKey?: string;
}

// Cached once per session: the scan does readdirSync + many reads across the repos
// and plugin-cache dirs, which made every MCP render (buildMcpList) hit disk and lag
// navigation. Embedded MCPs change only when plugins are added/removed (restart re-scans).
var EMBEDDED_MCP_CACHE: EmbeddedMcpScan | null = null;
/** Every MCP server shipped inside a plugin, across every home the registry declares. Scanned once per session. */
export function scanPluginEmbeddedMcps(): EmbeddedMcpScan {
  if (EMBEDDED_MCP_CACHE !== null) return EMBEDDED_MCP_CACHE;
  var embedded: Record<string, EmbeddedMcpServer> = {};
  var baseMcpNames: Record<string, boolean> = {};

  function scanReposDir(reposDir: string): void {
    if (!existsSync(reposDir)) return;
    try {
      var authors = readdirSync(reposDir);
      for (var author of authors) {
        var authorDir = join(reposDir, author);
        try {
          var repos = readdirSync(authorDir);
          for (var repo of repos) {
            var candidates = [
              join(authorDir, repo, ".mcp.json"),
              join(authorDir, repo, "plugin", ".mcp.json")
            ];
            for (var mcpFile of candidates) {
              if (existsSync(mcpFile)) {
                try {
                  var data = readJson<{ mcpServers?: Record<string, EmbeddedMcpServer> }>(mcpFile, {});
                  var servers = (data && data.mcpServers) || {};
                  for (var sname of Object.keys(servers)) {
                    var key = "plugin:" + repo.toLowerCase() + ":" + sname;
                    if (!embedded[key]) {
                      embedded[key] = Object.assign({ pluginSource: repo }, servers[sname]);
                      baseMcpNames[sname] = true;
                    }
                  }
                } catch {}
              }
            }
          }
        } catch {}
      }
    } catch {}
  }

  function scanPluginCache(cacheDir: string): void {
    if (!existsSync(cacheDir)) return;
    try {
      var orgs = readdirSync(cacheDir);
      for (var org of orgs) {
        var orgDir = join(cacheDir, org);
        try {
          var names = readdirSync(orgDir);
          for (var pname of names) {
            var pnameDir = join(orgDir, pname);
            try {
              var versions = readdirSync(pnameDir);
              versions.sort();
              var latest = versions[versions.length - 1];
              if (latest) {
                var candidates = [
                  join(pnameDir, latest, ".mcp.json"),
                  join(pnameDir, latest, "plugin", ".mcp.json")
                ];
                for (var mcpFile of candidates) {
                  if (existsSync(mcpFile)) {
                    try {
                      var data = readJson<{ mcpServers?: Record<string, EmbeddedMcpServer> }>(mcpFile, {});
                      var servers = (data && data.mcpServers) || {};
                      for (var sname of Object.keys(servers)) {
                        var key = "plugin:" + pname.toLowerCase() + ":" + sname;
                        if (!embedded[key]) {
                          embedded[key] = Object.assign({ pluginSource: pname }, servers[sname]);
                          baseMcpNames[sname] = true;
                        }
                      }
                    } catch {}
                  }
                }
              }
            } catch {}
          }
        } catch {}
      }
    } catch {}
  }

  // every home the registry declares, so an app installed after this library shipped is scanned too
  for (var desc of appDescriptors()) {
    var home = resolveHome(desc);
    if (!home) continue;
    scanReposDir(homePaths(home).reposDir);
    scanPluginCache(join(home, "plugins", "cache"));
  }

  EMBEDDED_MCP_CACHE = { servers: embedded, baseMcpNames: baseMcpNames };
  return EMBEDDED_MCP_CACHE;
}

/** The servers this home has configured, plus the embedded ones nothing has overridden. */
export function getInstalledMcpList(): McpRow[] {
  var config = loadMcpConfig();
  var servers = config.mcpServers || {};
  var list: McpRow[] = [];
  for (var name of Object.keys(servers)) {
    var s = servers[name];
    list.push({ name: name, command: s.command || "", args: s.args || [], env: s.env || {}, installed: true });
  }
  var embedded = scanPluginEmbeddedMcps();
  for (var ename of Object.keys(embedded.servers)) {
    if (!servers[ename]) {
      var e = embedded.servers[ename];
      list.push({ name: ename, command: e.command || "", args: e.args || [], env: e.env || {}, installed: true, pluginSource: e.pluginSource, embedded: true });
    }
  }
  return list;
}

/** The MCP marketplace list: the curated catalog plus any embedded server not already in it, ranked by stars. */
export function buildMcpList(categoryFilter?: string): McpRow[] {
  fetchCatalogsAsync();
  var installed = loadMcpConfig().mcpServers || {};
  var embedded = scanPluginEmbeddedMcps();
  var baseMcpNames = embedded.baseMcpNames;
  var list: McpRow[] = [];
  var seen: Record<string, boolean> = {};
  for (var entry of MCP_CATALOG) {
    if (categoryFilter && categoryFilter !== "All" && entry.category !== categoryFilter) continue;
    list.push({
      name: entry.name, desc: entry.desc, command: entry.command,
      args: entry.args.slice(), env: Object.assign({}, entry.env),
      category: entry.category, installed: !!(installed[entry.name] || baseMcpNames[entry.name]),
      stars: entry.stars, curated: entry.curated, full_name: entry.full_name
    });
    seen[entry.name] = true;
  }
  if (!categoryFilter || categoryFilter === "All") {
    for (var ename of Object.keys(embedded.servers)) {
      if (!seen[ename] && !installed[ename]) {
        var e = embedded.servers[ename];
        list.push({
          name: ename, desc: "Plugin MCP (" + (e.pluginSource || "unknown") + ")",
          command: e.command || "", args: e.args || [], env: e.env || {},
          category: "Plugin", installed: true, embedded: true, pluginSource: e.pluginSource
        });
      }
    }
  }
  // rank by GitHub stars, curated and registry entries are intermixed, not pinned;
  // unstarred (curated awaiting enrichment, embedded plugins) fall to the bottom
  list.sort(function (a, b) { return (b.stars || 0) - (a.stars || 0); });
  return list;
}

/** Writes one catalog entry into this home's MCP config. */
export function installMcpServer(entry: McpRow): void {
  var config = loadMcpConfig();
  var serverConfig: { command?: string; args?: string[]; env?: Record<string, string> } = { command: entry.command, args: (entry.args || []).slice() };
  var envKeys = Object.keys(entry.env || {});
  if (envKeys.length > 0) serverConfig.env = Object.assign({}, entry.env);
  config.mcpServers[entry.name] = serverConfig;
  saveMcpConfig(config);
}

/** Removes one server from that config. */
export function uninstallMcpServer(name: string): void {
  var config = loadMcpConfig();
  delete config.mcpServers[name];
  saveMcpConfig(config);
}

/**
 * The active loader extension's mcpServers() capability, normalized to the same
 * row shape the "installed" view renders: {name, transport, detail}. Returns
 * null when the capability isn't registered (caller falls back to the legacy
 * on-disk list); returns [] on a capability call error so a broken host doesn't
 * crash the TUI.
 */
export function getCapabilityMcpList(): McpRow[] | null {
  var fn = S.capabilities && S.capabilities.mcpServers;
  if (typeof fn !== "function") return null;
  try {
    var list = fn() || [];
    return list.map(function(srv): McpRow {
      return { name: srv.name, transport: srv.transport || "", detail: srv.detail || "", installed: true, fromCapability: true };
    });
  } catch (e) { return []; }
}

/**
 * Rows for the "Installed" MCP sub-tab. Prefers S.capabilities.mcpServers() over
 * the legacy MCP_CONFIG_PATH file when registered (the host app may not actually
 * read that file), and prepends a synthetic "＋ Add MCP server" action row when
 * addMcpServer is registered, the SAME isAction-row approach buildMarketplaceList()
 * uses, so S.mcpCursor keeps indexing straight into one flat array.
 */
export function buildInstalledMcpRows(): McpRow[] {
  var capList = getCapabilityMcpList();
  var rows = (capList !== null ? capList : getInstalledMcpList()).slice();
  var addFn = S.capabilities && S.capabilities.addMcpServer;
  if (typeof addFn === "function") {
    rows = ([{ isAction: true, actionKey: "add_mcp_server", name: "＋ Add MCP server" }] as McpRow[]).concat(rows);
  }
  return rows;
}

/** The action menu for one MCP row. */
export function getMcpActions(mitem: McpRow): ActionRow[] {
  var a: ActionRow[] = [];
  if (mitem.installed) {
    a.push({ key: "uninstall", label: "Uninstall" });
  } else {
    a.push({ key: "install", label: "Install" });
  }
  var envKeys = Object.keys(mitem.env || {});
  if (envKeys.length > 0) {
    a.push({ key: "configure", label: "Configure API keys" });
  }
  var npmPkg = (mitem.args || []).find(function(arg: string) { return arg.indexOf("@") !== -1 && arg !== "-y"; });
  if (npmPkg) {
    a.push({ key: "browser", label: "Open in browser" });
  }
  a.push({ key: "cancel", label: "Cancel" });
  return a;
}

