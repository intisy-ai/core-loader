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
import { SETTINGS } from "@intisy-ai/core";
import type { PluginEntry } from "./config.js";
import type { ActionRow } from "./action-row.js";
import type { ForeignPlugin } from "./app-capabilities.js";
import type { SettingsItem } from "./settings-model.js";
import type { ActionSpec, CapabilitySchema, FieldSpec, SectionSpec } from "./capability-shapes.js";

/** One plugin's row in the update-status cache the manager writes. */
interface UpdateCacheRow {
  /** Whether it is a git clone or an npm package. */
  kind?: string;
  /** Whether an update is waiting. */
  updateAvailable?: boolean;
  /** The remote commit the manager saw. */
  remoteHead?: string;
  /** When it was last updated, as the timestamp of the check that updated it. */
  updatedAt?: string;
}

/** The update-status cache, by plugin name. */
export interface UpdateCache {
  /** Each plugin's cached verdict. */
  plugins: Record<string, UpdateCacheRow>;
  /**
   * When the manager last ran its check.
   *
   * @remarks
   * A row whose `updatedAt` equals this was updated by that very run, which is how the Plugins page
   * can say what a silent background update changed.
   */
  checkedAt?: string;
}

/** What a plugin's `config schema` answers: its declared defaults, and what is on disk. */
export interface ConfigValues {
  /** The config name the plugin calls its own file, which is the only thing usable as a path. */
  name: string | null;
  /** Every setting's declared default. */
  defaults: Record<string, unknown>;
  /** What the file actually holds. */
  current: Record<string, unknown>;
}

/** A plugin's whole settings declaration, as the Settings tab and the config editor consume it. */
export interface PluginDeclaration {
  /** The plugin id every surface routes by. */
  name: string;
  /** What the plugin itself calls its config file. */
  configName: string | null;
  /** Its deployed bundle, which is what an action is run through, or `null` when it has none. */
  bundle: string | null;
  /** Its editable rows. */
  items: SettingsItem[];
  /** The actions it declared. */
  actions: ActionSpec[];
  /** The sections it contributed. */
  sections: SectionSpec[];
}

/** What `buildConfigItems` flattens: declared defaults, what is on disk, and how each is edited. */
export interface ConfigSchemaInput {
  /** Every setting's declared default. */
  defaults?: Record<string, unknown>;
  /** What the file actually holds. */
  current?: Record<string, unknown>;
  /** How each setting is edited. */
  fields?: FieldSpec[];
}

/**
 * One row of the Plugins list, whatever kind of plugin it describes.
 *
 * @remarks
 * Git clones, npm packages and the host app's own plugins land in ONE array so the cursor indexes
 * straight into it, so the fields only one kind fills are optional here rather than split across
 * three types the renderer would have to discriminate on every line.
 */
export interface PluginRow {
  /** The plugin's name. */
  name: string;
  /** Which kind of plugin this is: absent for a git clone, `npm` or `foreign` otherwise. */
  type?: string;
  /** Whether this row is the plugin manager itself. */
  engine?: boolean;
  /** Whether the host app manages this plugin rather than the loader. */
  foreign?: boolean;
  /** The marketplace or registry a host-managed plugin came from. */
  source?: string;
  /** A host-managed plugin's identifier, `name@source`. */
  key?: string;
  /** The clone directory under the repos dir. */
  folderName: string;
  /** Where it is cloned from. */
  url: string;
  /** Whether the manager updates it without being asked. */
  autoUpdate: boolean;
  /** Whether the loader deploys it. */
  enabled: boolean;
  /** Whether it is present locally. */
  installed: boolean;
  /** Whether its bundle is deployed into the app's plugin directory. */
  deployed: boolean;
  /** The local commit, for a git clone. */
  localHead: string;
  /** The remote commit, for a git clone whose remote has been read. */
  remoteHead: string;
  /** The version the row shows: a tag, a package version, or a short sha. */
  latestTag: string;
  /** The last commit's subject, or what kind of plugin this is when it has no commits. */
  subject: string;
  /** Whether an update is waiting. */
  updateAvail: boolean;
  /** When it was last updated, as the timestamp of the check that updated it. */
  updatedAt?: string | null;
  /** Whether a prerelease channel has something newer, or `null` when that was not asked. */
  experimentalAvailable?: boolean | null;
  /** Whether this clone is following the prerelease channel. */
  onExperimental?: boolean;
  /** Whether it must be built after a clone. */
  hasBuild: boolean;
  /** The deployed bundle's filename. */
  pluginFile?: string;
  /** An npm plugin's version. */
  version?: string;
  /** An npm plugin's entry exactly as the app's own list holds it. */
  raw?: unknown;
  /** The `plugins.json` entry this row was built from. */
  _raw?: PluginEntry;
}

/** One commit of a plugin's clone, as the commit log sub-view shows it. */
export interface CommitRow {
  /** The short sha. */
  hash: string;
  /** The commit subject. */
  subject: string;
  /** How long ago it landed, already rendered. */
  time: string;
}


export function gitText(args: string[], cwd: string): string {
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
    var data = readJson<UpdateCache>(cachePath);
    if (!data || typeof data !== "object" || !data.plugins) return null;
    return data;
  } catch { return null; }
}

export function buildPluginList(): PluginRow[] {
  var plugins = loadPlugins();
  var list: PluginRow[] = [];
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
    var updatedAt: string | null = null;
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
function gitTextAsync(args: string[], cwd: string, cb: (out: string) => void): void {
  exec(args.join(" "), { cwd: cwd, timeout: 15000 }, function(err: unknown, stdout: string) {
    cb(err ? "" : String(stdout || "").trim());
  });
}

// Fetch each git plugin's remote HEAD OFF the main thread (parallel), then invoke
// done() once all complete. `git fetch` hits the network (up to 15s each); running
// it synchronously would freeze the UI, so async keeps the loop free and the spinner animating.
export function fetchPluginRemotes(pluginItems: PluginRow[], done?: () => void): void {
  var targets = pluginItems.filter(function(p: PluginRow) { return p.type !== "npm" && !p.foreign && p.installed && p.enabled !== false; });
  var remaining = targets.length;
  if (remaining === 0) { if (done) done(); return; }
  targets.forEach(function(p: PluginRow) {
    var dir = join(REPOS_DIR, p.folderName);
    gitTextAsync(["git", "fetch", "origin"], dir, function() {
      var refs = ["origin/HEAD", "origin/main", "origin/master"];
      var ri = 0;
      var finish = function() {
        // The same test the manager's own update cache makes, deliberately repeated rather than
        // shared: the manager is a plugin, and a plugin is terminal, so nothing may reference one.
        // Only reached when the cache has no answer for this plugin; a cached verdict wins above.
        p.updateAvail = !!(p.localHead && p.remoteHead && p.localHead !== p.remoteHead);
        remaining--;
        if (remaining === 0 && done) done();
      };
      var tryRef = function() {
        if (ri >= refs.length) { finish(); return; }
        gitTextAsync(["git", "rev-parse", refs[ri]], dir, function(h: string) {
          if (h) { p.remoteHead = h; finish(); }
          else { ri++; tryRef(); }
        });
      };
      tryRef();
    });
  });
}

export function buildCombinedPluginList(): PluginRow[] {
  var git = buildPluginList();
  var savedPlugins = loadPlugins();
  var cache = readUpdateCache();
  // Where the app's own plugin list carries the manager, list it as the active engine.
  // It's transient (the app fetches it at runtime) so it has no resolvable version;
  // mark it active rather than "not installed".
  var npm = loadNpmPlugins().map(function(np): PluginRow {
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

// The host app's OWN plugins, exposed via S.capabilities.foreignPlugins() ->
// [{name, source, enabled, version}]. Absent capability -> []. Tagged `foreign: true`
// (+ `key` = "name@source", the CLI's own identifier) so callers can guard them out
// of every updater-only action (update/commits/configure operate on a git clone that
// simply doesn't exist for these rows).
export function buildForeignPluginList(): PluginRow[] {
  var fpFn = S.capabilities && S.capabilities.foreignPlugins;
  if (typeof fpFn !== "function") return [];
  var foreign: ForeignPlugin[] = [];
  try { foreign = fpFn() || []; } catch (e) { foreign = []; }
  return foreign.map(function(it: ForeignPlugin): PluginRow {
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
function pushDiagnostics(actions: ActionRow[], pluginId: string): void {
  if (ledgerRowFor(pluginId)) {
    actions.push({ cat: "Configure", key: "diagnostics", label: "Show plugin diagnostics" });
  }
}

export function getPluginActions(pitem: PluginRow): ActionRow[] {
  var a: ActionRow[] = [];
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
export function hostPluginId(pitem: PluginRow | null | undefined): string {
  if (!pitem) return "";
  return basename(pitem.pluginFile || (pitem.name + ".js"), ".js");
}

// Values only: a plugin's declared defaults and what is actually on disk. The declaration itself
// (fields, actions, sections) comes from the settings capability; this channel exists because a
// resolved config cannot say which keys are set and which are merely defaulted, and the editor's
// "(default)" marker is exactly that distinction.
export function probeConfigValuesAsync(bundle: string | null): Promise<ConfigValues | null> {
  return new Promise<ConfigValues | null>(function (resolve) {
    if (!bundle || !existsSync(bundle)) { resolve(null); return; }
    exec('node "' + bundle + '" config schema', { timeout: 8000 }, function (err: unknown, stdout: string) {
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
export function declarationOf(pluginId: string, bundle: string | null, schema: CapabilitySchema | null, values: ConfigValues | null): PluginDeclaration | null {
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
var DECLARATIONS = new Map<string, PluginDeclaration | null>();

export function declarationFor(pluginId: string): PluginDeclaration | null | undefined {
  return DECLARATIONS.has(pluginId) ? DECLARATIONS.get(pluginId) : undefined;
}

export async function readDeclaration(pluginId: string): Promise<PluginDeclaration | null> {
  var schema = await readSettingsSchema(pluginId);
  var bundle = bundleFor(pluginId);
  var values = await probeConfigValuesAsync(bundle);
  var declaration = declarationOf(pluginId, bundle, schema, values);
  DECLARATIONS.set(pluginId, declaration);
  return declaration;
}

export function invalidateDeclaration(pluginId: string): void {
  DECLARATIONS.delete(pluginId);
}

// Every plugin that provides the settings capability in this home.
export function settingsPluginIds() {
  return providerIds(SETTINGS);
}

// Read every settings declaration once at startup, so a menu opened later is not waiting on a
// child process to decide whether it has a Configure entry. Concurrently, because each read costs a
// spawn bounded at 8s: serially, one unresponsive bundle would hold up the first frame by itself.
export async function primeDeclarations() {
  const pending = settingsPluginIds().filter(function (pluginId) { return declarationFor(pluginId) === undefined; });
  await Promise.all(pending.map(function (pluginId) { return readDeclaration(pluginId); }));
}

function digPath(obj: unknown, dotKey: string): unknown {
  var node: unknown = obj;
  var parts = dotKey.split(".");
  for (var i = 0; i < parts.length; i++) {
    if (!node || typeof node !== "object" || !(parts[i] in node)) return undefined;
    node = (node as Record<string, unknown>)[parts[i]];
  }
  return node;
}

// A declared type outranks the value's own: a secret holding a string is still a secret, and only
// the declaration can say so.
function configRow(key: string, value: unknown, def: unknown, isSet: boolean, field?: FieldSpec): SettingsItem {
  var item: SettingsItem = { key: key, value: value, def: def, isSet: isSet, type: (field && typeof field.type === "string") ? field.type : typeof value };
  // A declared choice list turns a free-text row into one that steps through its options.
  if (field && Array.isArray(field.options) && field.options.length) item.options = field.options;
  return item;
}

// Flatten a schema into editable rows: every key (declared default or on-disk),
// its effective value, whether it is explicitly set, and its inferred type.
export function buildConfigItems(schema: ConfigSchemaInput | null | undefined): SettingsItem[] {
  var defaults = (schema && schema.defaults) || {};
  var current = (schema && schema.current) || {};
  var fields = (schema && schema.fields) || [];
  var byKey: Record<string, FieldSpec> = {};
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
  var seen: Record<string, boolean> = {};
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
export function setPluginConfig(bundle: string, key: string, valueStr: unknown): string {
  try {
    execSync('node "' + bundle + '" config set ' + JSON.stringify(key) + ' ' + JSON.stringify(String(valueStr)), { timeout: 8000, stdio: ["ignore", "ignore", "ignore"], env: spawnEnv() });
    return "";
  } catch (e) { return (e instanceof Error && e.message) || "set failed"; }
}
