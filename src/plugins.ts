// @ts-nocheck
// Plugin list building: git-backed repos + npm plugins + the updater engine
// row, remote-update detection, and the per-plugin action menu.

import { existsSync } from "fs";
import { readJson } from "./json.js";
import { join, dirname, basename } from "path";
import { execSync, exec } from "child_process";
import { REPOS_DIR, PLUGINS_DIR } from "./env.js";
import { loadPlugins } from "./config.js";
import { getFolderName, loadNpmPlugins, getUpdaterVersion, getUpdater, resolvedManager } from "./updater.js";
import { S } from "./state.js";
import { spawnEnv } from "./activity-seam.js";
import { bundleFor, ledgerRowFor, providerIds, readSettingsSchema } from "./plugin-surface.js";

export function gitText(args, cwd) {
  try {
    var out = execSync(args.join(" "), { cwd: cwd, encoding: "utf-8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
    return out.trim();
  } catch { return ""; }
}

// Reads the update-status cache the plugin manager WRITES (`<configDir>/cache/
// plugin-updates.json`, configDir = dirname(REPOS_DIR)), the single source of
// truth for real remote-vs-local update state. The plugin manager computes this
// during earlyLaunch (git fetch + npm registry checks); the TUI just reads it so
// the Installed list reflects reality on load, not only after a manual "F".
// Best-effort like every other cache read in this codebase: any failure (no
// file yet, bad JSON) returns null and callers fall back to current behavior.
export function readUpdateCache() {
  try {
    var cachePath = join(dirname(REPOS_DIR), "cache", "plugin-updates.json");
    var data = readJson(cachePath);
    if (!data || typeof data !== "object" || !data.plugins) return null;
    return data;
  } catch { return null; }
}

export function buildPluginList() {
  var plugins = loadPlugins();
  var list = [];
  var cache = readUpdateCache();
  var channelUpdater = getUpdater();
  var configDir = dirname(REPOS_DIR);
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

    var channelState = channelUpdater && typeof channelUpdater.pluginChannelState === "function"
      ? channelUpdater.pluginChannelState(configDir, p.name)
      : { onExperimental: false, experimentalAvailable: null };

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
      experimentalAvailable: channelState.experimentalAvailable,
      onExperimental: channelState.onExperimental,
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
        // The same test the manager's own update cache makes, deliberately repeated rather than
        // shared: this library carries no core submodule, so sharing one boolean would mean adding
        // one. Only reached when the cache has no answer for this plugin; a cached verdict wins above.
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
  // Where the app's own plugin list carries the manager, list it as the active engine.
  // It's transient (the app fetches it at runtime) so it has no resolvable version;
  // mark it active rather than "not installed".
  var npm = loadNpmPlugins().map(function(np) {
    var manager = resolvedManager();
    var isEngine = !!manager && (np.name === manager.npmName || np.name === manager.id);
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
      // npm plugins have no disable state, the app loads whatever its own list holds
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

// The host records a row for every plugin it saw, loaded or broken, so diagnostics are offered
// wherever there is one to show: a disabled plugin's row is often the most interesting of all.
function pushDiagnostics(actions, pluginId) {
  if (ledgerRowFor(pluginId)) {
    actions.push({ cat: "Configure", key: "diagnostics", label: "Show plugin diagnostics" });
  }
}

export function getPluginActions(pitem) {
  var a = [];
  var pluginId = hostPluginId(pitem);
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
    // managed via the app's own plugin list, no disable state, only update/uninstall (+ Configure
    // when its settings declaration has something editable, same gate as git plugins)
    var npmDeclaration = declarationFor(pluginId);
    if (npmDeclaration && npmDeclaration.items.length) {
      a.push({ cat: "Configure", key: "configure", label: "Configure settings (" + npmDeclaration.items.length + ")" });
    }
    pushDiagnostics(a, pluginId);
    a.push({ cat: "Update", key: "update-npm", label: "Update npm plugin" });
    a.push({ cat: "Manage", key: "uninstall-npm", label: "Uninstall npm plugin (removes it from the app's plugin list)" });
    a.push({ key: "cancel", label: "Cancel" });
    return a;
  }
  if (!pitem.enabled) {
    a.push({ key: "enable-plugin", label: "Enable plugin" });
    pushDiagnostics(a, pluginId);
    a.push({ key: "cancel", label: "Cancel" });
    return a;
  }
  // Configure: shown only for a plugin whose settings capability declared something editable.
  var declaration = declarationFor(pluginId);
  if (declaration && declaration.items.length) {
    a.push({ cat: "Configure", key: "configure", label: "Configure settings (" + declaration.items.length + ")" });
  }
  pushDiagnostics(a, pluginId);
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
  // Gate on the resolved state: a plugin riding the home's global yes is already on the channel.
  if (pitem.experimentalAvailable === true) {
    if (pitem.onExperimental) {
      a.push({ cat: "Settings", key: "channel-stable", label: "Switch back to stable" });
    } else {
      a.push({ cat: "Settings", key: "channel-experimental", label: "Switch to experimental build" });
    }
  }
  a.push({ cat: "Settings", key: "commits", label: "Select specific commit (Downgrade)" });
  a.push({ cat: "Manage", key: "disable-plugin", label: "Disable plugin" });
  a.push({ cat: "Manage", key: "uninstall-plugin", label: "Uninstall plugin" });
  a.push({ key: "cancel", label: "Cancel" });
  return a;
}

// The id the plugin host knows a list item by. The host derives a plugin's id from its DEPLOYED
// sidecar/bundle basename, which is not always the plugins.json name: an entry may name its own
// pluginFile, and every bundle path in this repo is built from the same expression.
export function hostPluginId(pitem) {
  if (!pitem) return "";
  return basename(pitem.pluginFile || (pitem.name + ".js"), ".js");
}

// Values only: a plugin's declared defaults and what is actually on disk. The declaration itself
// (fields, actions, sections) comes from the settings capability; this channel exists because a
// resolved config cannot say which keys are set and which are merely defaulted, and the editor's
// "(default)" marker is exactly that distinction.
export function probeConfigValuesAsync(bundle) {
  return new Promise(function (resolve) {
    if (!bundle || !existsSync(bundle)) { resolve(null); return; }
    exec('node "' + bundle + '" config schema', { timeout: 8000 }, function (err, stdout) {
      if (err) { resolve(null); return; }
      try {
        var data = JSON.parse(String(stdout).trim());
        if (!data || typeof data !== "object") { resolve(null); return; }
        resolve({ name: typeof data.name === "string" ? data.name : null, defaults: data.defaults || {}, current: data.current || {} });
      } catch (e) { resolve(null); }
    });
  });
}

// A plugin's whole settings declaration as the Settings tab and the config editor consume it. A
// plugin offering neither settings nor actions has nothing to configure, which is what yields null.
// `name` is the id every surface routes by; `configName` is what the plugin itself calls its config
// file, which is the only thing that may be used as a path.
export function declarationOf(pluginId, bundle, schema, values) {
  var items = buildConfigItems({
    defaults: (values && values.defaults) || {},
    current: (values && values.current) || {},
    fields: (schema && schema.fields) || [],
  });
  var actions = (schema && Array.isArray(schema.actions)) ? schema.actions : [];
  var sections = (schema && Array.isArray(schema.sections)) ? schema.sections : [];
  if (!items.length && !actions.length) return null;
  return {
    name: pluginId,
    configName: (values && values.name) || null,
    bundle: bundle,
    items: items,
    actions: actions,
    sections: sections,
  };
}

// Declarations are cached per plugin: reading one costs a capability call plus a child process, and
// every settings render walks the whole list. An absent key means "not read yet" and a null value
// means "read, and this plugin has nothing to configure".
var DECLARATIONS = new Map();

export function declarationFor(pluginId) {
  return DECLARATIONS.has(pluginId) ? DECLARATIONS.get(pluginId) : undefined;
}

export async function readDeclaration(pluginId) {
  var schema = await readSettingsSchema(pluginId);
  var bundle = bundleFor(pluginId);
  var values = await probeConfigValuesAsync(bundle);
  var declaration = declarationOf(pluginId, bundle, schema, values);
  DECLARATIONS.set(pluginId, declaration);
  return declaration;
}

export function invalidateDeclaration(pluginId) {
  DECLARATIONS.delete(pluginId);
}

// Every plugin that provides the settings capability in this home.
export function settingsPluginIds() {
  return providerIds("settings");
}

// Read every settings declaration once at startup, so a menu opened later is not waiting on a
// child process to decide whether it has a Configure entry. Concurrently, because each read costs a
// spawn bounded at 8s: serially, one unresponsive bundle would hold up the first frame by itself.
export async function primeDeclarations() {
  const pending = settingsPluginIds().filter(function (pluginId) { return declarationFor(pluginId) === undefined; });
  await Promise.all(pending.map(function (pluginId) { return readDeclaration(pluginId); }));
}

function digPath(obj, dotKey) {
  var node = obj;
  var parts = dotKey.split(".");
  for (var i = 0; i < parts.length; i++) {
    if (!node || typeof node !== "object" || !(parts[i] in node)) return undefined;
    node = node[parts[i]];
  }
  return node;
}

// A declared type outranks the value's own: a secret holding a string is still a secret, and only
// the declaration can say so.
function configRow(key, value, def, isSet, field) {
  var item = { key: key, value: value, def: def, isSet: isSet, type: (field && typeof field.type === "string") ? field.type : typeof value };
  // A declared choice list turns a free-text row into one that steps through its options.
  if (field && Array.isArray(field.options) && field.options.length) item.options = field.options;
  return item;
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
  var rows = Object.keys(merged).filter(function (k) {
    var v = merged[k];
    return v === null || typeof v !== "object";
  }).map(function (k) {
    var isSet = Object.prototype.hasOwnProperty.call(current, k);
    return configRow(k, isSet ? current[k] : defaults[k], defaults[k], isSet, byKey[k]);
  });

  // A declared key may address a leaf INSIDE one of those objects ("categories.accounts").
  // Those are editable after all, since core's config get/set both take a dot path, and
  // without this the only way to reach them is the dashboard.
  var seen = {};
  for (var r = 0; r < rows.length; r++) seen[rows[r].key] = true;
  for (var f = 0; f < fields.length; f++) {
    var field = fields[f];
    if (!field || typeof field.key !== "string" || field.key.indexOf(".") < 0 || seen[field.key]) continue;
    var cur = digPath(current, field.key);
    var def = digPath(defaults, field.key);
    if (cur === undefined && def === undefined) continue;
    var value = cur !== undefined ? cur : def;
    if (value !== null && typeof value === "object") continue;
    rows.push(configRow(field.key, value, def, cur !== undefined, field));
  }
  return rows;
}

// Persist one setting by shelling back into the plugin's own config CLI: `config set`
// is the only thing that writes a file, so a config appears only once actually changed.
export function setPluginConfig(bundle, key, valueStr) {
  try {
    execSync('node "' + bundle + '" config set ' + JSON.stringify(key) + ' ' + JSON.stringify(String(valueStr)), { timeout: 8000, stdio: ["ignore", "ignore", "ignore"], env: spawnEnv() });
    return "";
  } catch (e) { return (e && e.message) || "set failed"; }
}

