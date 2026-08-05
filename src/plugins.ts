// @ts-nocheck
// Plugin list building: git-backed repos + npm plugins + the updater engine
// row, remote-update detection, and the per-plugin action menu.

import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { execSync, exec } from "child_process";
import { REPOS_DIR, PLUGINS_DIR } from "./env.js";
import { loadPlugins } from "./config.js";
import { getFolderName, loadNpmPlugins, getUpdaterVersion } from "./updater.js";
import { S } from "./state.js";
import { spawnEnv } from "./activity-seam.js";

export function gitText(args, cwd) {
  try {
    var out = execSync(args.join(" "), { cwd: cwd, encoding: "utf-8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
    return out.trim();
  } catch { return ""; }
}

// Reads the update-status cache plugin-updater WRITES (`<configDir>/cache/
// plugin-updates.json`, configDir = dirname(REPOS_DIR)), the single source of
// truth for real remote-vs-local update state. plugin-updater computes this
// during earlyLaunch (git fetch + npm registry checks); the TUI just reads it so
// the Installed list reflects reality on load, not only after a manual "F".
// Best-effort like every other cache read in this codebase: any failure (no
// file yet, bad JSON) returns null and callers fall back to current behavior.
export function readUpdateCache() {
  try {
    var cachePath = join(dirname(REPOS_DIR), "cache", "plugin-updates.json");
    if (!existsSync(cachePath)) return null;
    var data = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (!data || typeof data !== "object" || !data.plugins) return null;
    return data;
  } catch { return null; }
}

export function buildPluginList() {
  var plugins = loadPlugins();
  var list = [];
  var cache = readUpdateCache();
  for (var p of plugins) {
    var folderName = getFolderName(p);
    var dir = join(REPOS_DIR, folderName);
    var installed = existsSync(dir);
    var deployed = existsSync(join(PLUGINS_DIR, (p.pluginFile || p.name + ".js")));
    var localHead = "";
    var remoteHead = "";
    var subject = "";
    var updateAvail = false;
    var updatedAt = null;
    var latestTag = "";
    var enabled = p.enabled !== false;

      if (installed) {
        localHead = gitText(["git", "rev-parse", "HEAD"], dir);
        subject = gitText(["git", "log", "-1", "--format=%s"], dir);
        var desc = gitText(["git", "describe", "--tags", "--always"], dir);
        if (!desc || /^[0-9a-f]+$/.test(desc)) {
          latestTag = ""; // no tags in repo, row falls back to the sha
        } else {
          var tmatch = desc.match(/^(.*)-\d+-g[0-9a-f]+$/);
          latestTag = tmatch ? tmatch[1] + " (" + localHead.substring(0, 7) + ")" : desc;
        }
      }

    var centry = cache && cache.plugins && cache.plugins[p.name];
    if (centry && centry.kind === "git") {
      updateAvail = !!centry.updateAvailable;
      if (centry.remoteHead) remoteHead = centry.remoteHead;
      if (centry.updatedAt) updatedAt = centry.updatedAt;
    }

    list.push({
      name: p.name,
      folderName: folderName,
      url: p.url,
      autoUpdate: p.autoUpdate !== false,
      enabled: enabled,
      installed: installed,
      deployed: deployed,
      localHead: localHead,
      remoteHead: remoteHead,
      latestTag: latestTag,
      subject: subject,
      updateAvail: updateAvail,
      updatedAt: updatedAt,
      hasBuild: !!(p.build || p.bundle),
      pluginFile: p.pluginFile,
      _raw: p
    });
  }
  return list;
}

// async git text (non-blocking), so a network `git fetch` never blocks the TUI loop
function gitTextAsync(args, cwd, cb) {
  exec(args.join(" "), { cwd: cwd, timeout: 15000 }, function(err, stdout) {
    cb(err ? "" : String(stdout || "").trim());
  });
}

// Fetch each git plugin's remote HEAD OFF the main thread (parallel), then invoke
// done() once all complete. `git fetch` hits the network (up to 15s each); running
// it synchronously would freeze the UI, so async keeps the loop free and the spinner animating.
export function fetchPluginRemotes(pluginItems, done) {
  var targets = pluginItems.filter(function(p) { return p.type !== "npm" && !p.foreign && p.installed && p.enabled !== false; });
  var remaining = targets.length;
  if (remaining === 0) { if (done) done(); return; }
  targets.forEach(function(p) {
    var dir = join(REPOS_DIR, p.folderName);
    gitTextAsync(["git", "fetch", "origin"], dir, function() {
      var refs = ["origin/HEAD", "origin/main", "origin/master"];
      var ri = 0;
      var finish = function() {
        p.updateAvail = !!(p.localHead && p.remoteHead && p.localHead !== p.remoteHead);
        remaining--;
        if (remaining === 0 && done) done();
      };
      var tryRef = function() {
        if (ri >= refs.length) { finish(); return; }
        gitTextAsync(["git", "rev-parse", refs[ri]], dir, function(h) {
          if (h) { p.remoteHead = h; finish(); }
          else { ri++; tryRef(); }
        });
      };
      tryRef();
    });
  });
}

export function buildCombinedPluginList() {
  var git = buildPluginList();
  var savedPlugins = loadPlugins();
  var cache = readUpdateCache();
  // Under OpenCode plugin-updater IS an npm plugin (opencode.jsonc); list it as the
  // active engine. It's transient (opencode fetches it at runtime) so it has no
  // resolvable version; mark it active rather than "not installed". Under Claude
  // loadNpmPlugins is empty (no opencode.jsonc), so no npm rows appear at all.
  var npm = loadNpmPlugins().map(function(np) {
    var isEngine = np.name === "plugin-updater";
    var ncEntry = cache && cache.plugins && cache.plugins[np.name];
    var npmUpdateAvail = !!(ncEntry && ncEntry.kind === "npm" && ncEntry.updateAvailable);
    return {
      type: "npm",
      engine: isEngine,
      name: np.name,
      // the engine is transient (no package-cache version), read its real version
      // from the resolved updater bundle instead of leaving it blank.
      version: isEngine ? (getUpdaterVersion() || np.version) : np.version,
      raw: np.raw,
      // npm plugins have no disable state, the app loads whatever opencode.jsonc lists
      enabled: true,
      autoUpdate: false,
      installed: isEngine ? true : !!np.version,
      deployed: isEngine ? true : !!np.version,
      updateAvail: npmUpdateAvail,
      updatedAt: (ncEntry && ncEntry.updatedAt) || null,
      localHead: "",
      remoteHead: "",
      latestTag: np.version || "",
      subject: "npm plugin",
      folderName: "",
      url: "",
      hasBuild: false,
      pluginFile: ""
    };
  });
  return git.concat(npm).concat(buildForeignPluginList());
}

// The host app's OWN plugins (e.g. Claude Code's native plugin system), exposed
// read-only-no-more via S.capabilities.foreignPlugins() -> [{name, source, enabled,
// version}]. Absent capability (opencode) -> []. Tagged `foreign: true` (+ `key` =
// "name@source", the CLI's own identifier) so callers can guard them out of every
// updater-only action (update/commits/configure operate on a git clone that simply
// doesn't exist for these rows).
export function buildForeignPluginList() {
  var fpFn = S.capabilities && S.capabilities.foreignPlugins;
  if (typeof fpFn !== "function") return [];
  var foreign = [];
  try { foreign = fpFn() || []; } catch (e) { foreign = []; }
  return foreign.map(function(it) {
    return {
      type: "foreign",
      foreign: true,
      name: it.name,
      source: it.source,
      key: it.name + "@" + it.source,
      version: it.version,
      enabled: it.enabled !== false,
      autoUpdate: false,
      installed: true,
      deployed: true,
      updateAvail: false,
      localHead: "",
      remoteHead: "",
      latestTag: it.version || "",
      subject: "App plugin" + (it.source ? " · " + it.source : ""),
      folderName: "",
      url: "",
      hasBuild: false,
      pluginFile: ""
    };
  });
}

export function getPluginActions(pitem) {
  var a = [];
  if (pitem.foreign) {
    // App-managed plugin (native to the host app): only what the capabilities
    // actually support. Neither registered (opencode) -> Cancel only.
    var toggleFn = S.capabilities && S.capabilities.setForeignPluginEnabled;
    var uninstallFn = S.capabilities && S.capabilities.uninstallForeignPlugin;
    if (typeof toggleFn === "function") {
      a.push({ key: "foreign-toggle", label: (pitem.enabled ? "Disable" : "Enable") + " plugin" });
    }
    if (typeof uninstallFn === "function") {
      a.push({ cat: "Manage", key: "foreign-uninstall", label: "Uninstall plugin" });
    }
    a.push({ key: "cancel", label: "Cancel" });
    return a;
  }
  if (pitem.type === "npm") {
    // managed via opencode.json, no disable state, only update/uninstall (+ Configure
    // when the deployed bundle answers `config schema`, same probe as git plugins)
    if (pitem._cfg && pitem._cfg.items && pitem._cfg.items.length) {
      a.push({ cat: "Configure", key: "configure", label: "Configure settings (" + pitem._cfg.items.length + ")" });
    }
    a.push({ cat: "Update", key: "update-npm", label: "Update npm plugin" });
    a.push({ cat: "Manage", key: "uninstall-npm", label: "Uninstall npm plugin (removes from opencode.json)" });
    a.push({ key: "cancel", label: "Cancel" });
    return a;
  }
  if (!pitem.enabled) {
    a.push({ key: "enable-plugin", label: "Enable plugin" });
    a.push({ key: "cancel", label: "Cancel" });
    return a;
  }
  // Configure: shown only for plugins that use our core (their bundle answers
  // `config schema`). Probed + cached on the item when the action menu opens.
  if (pitem._cfg && pitem._cfg.items && pitem._cfg.items.length) {
    a.push({ cat: "Configure", key: "configure", label: "Configure settings (" + pitem._cfg.items.length + ")" });
  }
  if (pitem.updateAvail || !pitem.deployed) {
    a.push({ cat: "Update", key: "update", label: "Update now" });
  }
  a.push({ cat: "Update", key: "check-updates", label: "Check for updates" });
  a.push({ cat: "Update", key: "update-all", label: "Update all plugins" });
  a.push({ cat: "Update", key: "update", label: "Force rebuild & deploy" });
  a.push({ cat: "Update", key: "refresh", label: "Refresh list" });
  if (pitem.autoUpdate) {
    a.push({ cat: "Settings", key: "disable-auto", label: "Set to manual update" });
  } else {
    a.push({ cat: "Settings", key: "enable-auto", label: "Enable auto-update" });
  }
  a.push({ cat: "Settings", key: "commits", label: "Select specific commit (Downgrade)" });
  a.push({ cat: "Manage", key: "disable-plugin", label: "Disable plugin" });
  a.push({ cat: "Manage", key: "uninstall-plugin", label: "Uninstall plugin" });
  a.push({ key: "cancel", label: "Cancel" });
  return a;
}

// Probe a deployed plugin bundle for its config schema. A plugin built on our core
// answers `node <bundle> config schema` with {name, defaults, current}; anything else
// (non-core plugins, undeployed items, parse error) yields null -> no Configure action.
// Runs for git AND npm plugins alike, an npm plugin built on our core is just as
// probeable via its deployed bundle file.
export function probeConfigSchema(pitem) {
  if (!pitem || !pitem.deployed || pitem.foreign) return null;
  var bundle = join(PLUGINS_DIR, (pitem.pluginFile || pitem.name + ".js"));
  if (!existsSync(bundle)) return null;
  try {
    var out = execSync('node "' + bundle + '" config schema', { encoding: "utf-8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
    var data = JSON.parse(String(out).trim());
    if (!data || typeof data !== "object") return null;
    var items = buildConfigItems(data);
    if (!items.length) return null;
    return { name: data.name || pitem.name, bundle: bundle, items: items };
  } catch { return null; }
}

// Async twin of probeConfigSchema (uses exec, not execSync) so the Settings tab can probe
// plugin schemas in the background without blocking the render; never resolves rejected.
export function probeConfigSchemaAsync(pitem) {
  return new Promise(function (resolve) {
    if (!pitem || !pitem.deployed || pitem.foreign) { resolve(null); return; }
    var bundle = join(PLUGINS_DIR, (pitem.pluginFile || pitem.name + ".js"));
    if (!existsSync(bundle)) { resolve(null); return; }
    exec('node "' + bundle + '" config schema', { timeout: 8000 }, function (err, stdout) {
      if (err) { resolve(null); return; }
      try {
        var data = JSON.parse(String(stdout).trim());
        if (!data || typeof data !== "object") { resolve(null); return; }
        var items = buildConfigItems(data);
        if (!items.length) { resolve(null); return; }
        resolve({ name: data.name || pitem.name, bundle: bundle, items: items });
      } catch (e) { resolve(null); }
    });
  });
}

// Flatten a schema into editable rows: every key (declared default or on-disk),
// its effective value, whether it is explicitly set, and its inferred type.
export function buildConfigItems(schema) {
  var defaults = (schema && schema.defaults) || {};
  var current = (schema && schema.current) || {};
  var fields = (schema && schema.fields) || [];
  var byKey = {};
  for (var i = 0; i < fields.length; i++) { if (fields[i] && fields[i].key) byKey[fields[i].key] = fields[i]; }
  var merged = Object.assign({}, defaults, current);
  // A nested object cannot be edited through a text row: typing JSON into one would be
  // stored as a string and corrupt the setting. Surfaces that can edit structure (the
  // dashboard) read the same config directly.
  return Object.keys(merged).filter(function (k) {
    var v = merged[k];
    return v === null || typeof v !== "object";
  }).map(function (k) {
    var isSet = Object.prototype.hasOwnProperty.call(current, k);
    var value = isSet ? current[k] : defaults[k];
    var field = byKey[k];
    var item = { key: k, value: value, def: defaults[k], isSet: isSet, type: typeof value };
    // A declared choice list turns a free-text row into one that steps through its options.
    if (field && Array.isArray(field.options) && field.options.length) item.options = field.options;
    return item;
  });
}

// Persist one setting by shelling back into the plugin's own config CLI: `config set`
// is the only thing that writes a file, so a config appears only once actually changed.
export function setPluginConfig(bundle, key, valueStr) {
  try {
    execSync('node "' + bundle + '" config set ' + JSON.stringify(key) + ' ' + JSON.stringify(String(valueStr)), { timeout: 8000, stdio: ["ignore", "ignore", "ignore"], env: spawnEnv() });
    return "";
  } catch (e) { return (e && e.message) || "set failed"; }
}

