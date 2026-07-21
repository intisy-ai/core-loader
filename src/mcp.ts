// @ts-nocheck
// MCP server catalog, install/uninstall, and the per-server action menu.
// Merges the curated MCP_CATALOG with plugin-embedded .mcp.json servers.

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { HOME, MCP_CATALOG } from "./env.js";
import { loadMcpConfig, saveMcpConfig } from "./config.js";
import { fetchCatalogsAsync } from "./marketplace.js";
import { S } from "./state.js";

// Cached once per session: the scan does readdirSync + many reads across the repos
// and plugin-cache dirs, which made every MCP render (buildMcpList) hit disk and lag
// navigation. Embedded MCPs change only when plugins are added/removed (restart re-scans).
var EMBEDDED_MCP_CACHE = null;
export function scanPluginEmbeddedMcps() {
  if (EMBEDDED_MCP_CACHE !== null) return EMBEDDED_MCP_CACHE;
  var embedded = {};
  var baseMcpNames = {};

  function scanReposDir(reposDir) {
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
                  var data = JSON.parse(readFileSync(mcpFile, "utf-8"));
                  var servers = data.mcpServers || {};
                  for (var sname of Object.keys(servers)) {
                    var key = "plugin:" + repo.toLowerCase() + ":" + sname;
                    if (!embedded[key]) {
                      embedded[key] = Object.assign({ _pluginSource: repo }, servers[sname]);
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

  function scanPluginCache(cacheDir) {
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
                      var data = JSON.parse(readFileSync(mcpFile, "utf-8"));
                      var servers = data.mcpServers || {};
                      for (var sname of Object.keys(servers)) {
                        var key = "plugin:" + pname.toLowerCase() + ":" + sname;
                        if (!embedded[key]) {
                          embedded[key] = Object.assign({ _pluginSource: pname }, servers[sname]);
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

  var claudeDir = join(HOME, ".config", "claude");
  var ocDir = join(HOME, ".config", "opencode");
  scanReposDir(join(claudeDir, "repos"));
  scanReposDir(join(ocDir, "repos"));
  scanPluginCache(join(claudeDir, "plugins", "cache"));
  scanPluginCache(join(ocDir, "plugins", "cache"));

  embedded._baseMcpNames = baseMcpNames;
  EMBEDDED_MCP_CACHE = embedded;
  return embedded;
}

export function getInstalledMcpList() {
  var config = loadMcpConfig();
  var servers = config.mcpServers || {};
  var list = [];
  for (var name of Object.keys(servers)) {
    var s = servers[name];
    list.push({ name: name, command: s.command || "", args: s.args || [], env: s.env || {}, installed: true });
  }
  var embedded = scanPluginEmbeddedMcps();
  for (var ename of Object.keys(embedded)) {
    if (ename === "_baseMcpNames") continue;
    if (!servers[ename]) {
      var e = embedded[ename];
      list.push({ name: ename, command: e.command || "", args: e.args || [], env: e.env || {}, installed: true, pluginSource: e._pluginSource, embedded: true });
    }
  }
  return list;
}

export function buildMcpList(categoryFilter) {
  fetchCatalogsAsync();
  var installed = loadMcpConfig().mcpServers || {};
  var embedded = scanPluginEmbeddedMcps();
  var baseMcpNames = embedded._baseMcpNames || {};
  var list = [];
  var seen = {};
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
    for (var ename of Object.keys(embedded)) {
      if (ename === "_baseMcpNames") continue;
      if (!seen[ename] && !installed[ename]) {
        var e = embedded[ename];
        list.push({
          name: ename, desc: "Plugin MCP (" + (e._pluginSource || "unknown") + ")",
          command: e.command || "", args: e.args || [], env: e.env || {},
          category: "Plugin", installed: true, embedded: true, pluginSource: e._pluginSource
        });
      }
    }
  }
  // rank by GitHub stars, curated and registry entries are intermixed, not pinned;
  // unstarred (curated awaiting enrichment, embedded plugins) fall to the bottom
  list.sort(function (a, b) { return (b.stars || 0) - (a.stars || 0); });
  return list;
}

export function installMcpServer(entry) {
  var config = loadMcpConfig();
  var serverConfig = { command: entry.command, args: entry.args.slice() };
  var envKeys = Object.keys(entry.env || {});
  if (envKeys.length > 0) serverConfig.env = Object.assign({}, entry.env);
  config.mcpServers[entry.name] = serverConfig;
  saveMcpConfig(config);
}

export function uninstallMcpServer(name) {
  var config = loadMcpConfig();
  delete config.mcpServers[name];
  saveMcpConfig(config);
}

// The active loader extension's mcpServers() capability, normalized to the same
// row shape the "installed" view renders: {name, transport, detail}. Returns
// null when the capability isn't registered (caller falls back to the legacy
// on-disk list); returns [] on a capability call error so a broken host doesn't
// crash the TUI.
export function getCapabilityMcpList() {
  var fn = S.capabilities && S.capabilities.mcpServers;
  if (typeof fn !== "function") return null;
  try {
    var list = fn() || [];
    return list.map(function(srv) {
      return { name: srv.name, transport: srv.transport || "", detail: srv.detail || "", installed: true, fromCapability: true };
    });
  } catch (e) { return []; }
}

// Rows for the "Installed" MCP sub-tab. Prefers S.capabilities.mcpServers() over
// the legacy MCP_CONFIG_PATH file when registered (the host app may not actually
// read that file), and prepends a synthetic "＋ Add MCP server" action row when
// addMcpServer is registered, the SAME isAction-row approach buildMarketplaceList()
// uses, so S.mcpCursor keeps indexing straight into one flat array.
export function buildInstalledMcpRows() {
  var capList = getCapabilityMcpList();
  var rows = (capList !== null ? capList : getInstalledMcpList()).slice();
  var addFn = S.capabilities && S.capabilities.addMcpServer;
  if (typeof addFn === "function") {
    rows = [{ isAction: true, actionKey: "add_mcp_server", name: "＋ Add MCP server" }].concat(rows);
  }
  return rows;
}

export function getMcpActions(mitem) {
  var a = [];
  if (mitem.installed) {
    a.push({ key: "uninstall", label: "Uninstall" });
  } else {
    a.push({ key: "install", label: "Install" });
  }
  var envKeys = Object.keys(mitem.env || {});
  if (envKeys.length > 0) {
    a.push({ key: "configure", label: "Configure API keys" });
  }
  var npmPkg = (mitem.args || []).find(function(arg) { return arg.indexOf("@") !== -1 && arg !== "-y"; });
  if (npmPkg) {
    a.push({ key: "browser", label: "Open in browser" });
  }
  a.push({ key: "cancel", label: "Cancel" });
  return a;
}

