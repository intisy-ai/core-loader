// Pure builder for the Settings tab: assembles the global settings section plus one
// section per plugin declaring something configurable, then the flat entry list the renderer
// and key handler both walk: a "Global" header + its group, then a "Plugins" header + one
// group row per plugin. Headers are not selectable (nav skips them). Git-free: the
// Versioning tab owns its own UI.
import { buildConfigItems, declarationFor, settingsPluginIds } from "./plugins.js";
import { GLOBAL_SETTINGS_DEFAULTS, loadGlobalSettings } from "./config.js";
import { S } from "./state.js";

export type SettingsItem = { key: string; value: unknown; def: unknown; isSet: boolean; type: string };
export type SettingsAction = { kind: "action"; key: string; label: string; description?: string; confirm?: string; danger?: boolean };
export type SettingsRow = SettingsItem | SettingsAction;
export type SettingsSection = {
  label: string;
  kind: "global" | "plugin";
  // The plugin this section belongs to, which is how a surface routes an action run or a re-read
  // back to its owner.
  plugin?: string;
  file: string;
  bundle: string | null;
  items: SettingsRow[];
  // Set on a section a plugin CONTRIBUTED (as opposed to its own flat config), so every
  // surface can say who added it and re-resolve it after a write.
  addedBy?: string;
  sectionId?: string;
  description?: string;
  order?: number;
};

// The host loader injects core's own declaration of the shared settings (defaults plus
// field types), so a key core adds shows up here with no change. The local constant is
// only the fallback for a host that injects nothing.
export function buildGlobalSection(): SettingsSection {
  const injected = (S.capabilities && (S.capabilities as any).globalSettings) || null;
  const defaults = (injected && injected.defaults) || GLOBAL_SETTINGS_DEFAULTS;
  const fields = (injected && injected.fields) || [];
  const items = buildConfigItems({ defaults, fields, current: loadGlobalSettings() }) as SettingsItem[];
  return { label: "Global", kind: "global", file: "settings.json", bundle: null, items };
}

// The config file a declaration edits. This is read back as a real path (the editor header, and the
// Versioning tab's key history looks the file up by it), so it follows the config name the plugin
// reports for ITSELF, never the id surfaces route by. One helper, so a second caller cannot drift.
export function configFileFor(cfg: any): string {
  return ((cfg && cfg.configName) || (cfg && cfg.name)) + ".json";
}

function actionRow(action: any): SettingsAction {
  const row: SettingsAction = { kind: "action", key: action.id, label: action.label };
  if (typeof action.description === "string") row.description = action.description;
  if (typeof action.confirm === "string") row.confirm = action.confirm;
  if (action.danger === true) row.danger = true;
  return row;
}

// The claim rule, applied to this surface's flat rows: a setting or action NAMED by a
// contributed section belongs to that section, and whatever no section claimed stays the
// plugin's own group. A section that claims nothing resolvable is dropped rather than
// listed empty.
export function splitBySections(cfg: any): SettingsSection[] {
  const name = cfg.name;
  const file = configFileFor(cfg);
  const itemByKey = new Map<string, SettingsRow>((cfg.items || []).map((i: SettingsItem) => [i.key, i]));
  const actionById = new Map<string, any>((cfg.actions || []).map((a: any) => [a.id, a]));
  const claimed = new Set<string>();
  const sections: SettingsSection[] = [];

  for (const spec of cfg.sections || []) {
    if (!spec || typeof spec.id !== "string" || typeof spec.label !== "string") continue;
    const rows: SettingsRow[] = [];
    for (const key of spec.fields || []) {
      const item = itemByKey.get(key);
      if (item && !claimed.has("f:" + key)) { rows.push(item); claimed.add("f:" + key); }
    }
    for (const id of spec.actions || []) {
      const action = actionById.get(id);
      if (action && !claimed.has("a:" + id)) { rows.push(actionRow(action)); claimed.add("a:" + id); }
    }
    if (!rows.length) continue;
    const section: SettingsSection = { label: spec.label, kind: "plugin", plugin: name, file, bundle: cfg.bundle, items: rows, addedBy: name, sectionId: spec.id };
    if (typeof spec.description === "string") section.description = spec.description;
    if (typeof spec.order === "number") section.order = spec.order;
    sections.push(section);
  }

  const rest: SettingsRow[] = (cfg.items || []).filter((i: SettingsItem) => !claimed.has("f:" + i.key));
  for (const action of cfg.actions || []) {
    if (!claimed.has("a:" + action.id)) rest.push(actionRow(action));
  }
  if (rest.length) sections.push({ label: name, kind: "plugin", plugin: name, file, bundle: cfg.bundle, items: rest });
  return sections;
}

// Only declarations already read: this runs on a render path, so it never starts a capability call
// or a child process of its own.
export function buildPluginSections(): SettingsSection[] {
  const out: SettingsSection[] = [];
  for (const pluginId of settingsPluginIds()) {
    const declaration = declarationFor(pluginId);
    if (!declaration) continue;
    out.push(...splitBySections(declaration));
  }
  return out;
}

export type SettingsEntry =
  | { type: "header"; label: string }
  | { type: "group"; section: SettingsSection }
  | { type: "loading"; label: string };   // a plugin whose declaration has not landed yet

// `sections` holds only resolved groups (Global + plugins with settings); `loading` holds the
// ids of plugins whose declaration is still being read in the background (rendered with a spinner).
export function buildSettingsEntries(sections: SettingsSection[], loading: string[] = []): SettingsEntry[] {
  const entries: SettingsEntry[] = [];
  const globals = sections.filter((s) => s.kind === "global");
  const plugins = sections.filter((s) => s.kind === "plugin");
  if (globals.length) {
    entries.push({ type: "header", label: "Global" });
    for (const s of globals) entries.push({ type: "group", section: s });
  }
  if (plugins.length || loading.length) {
    entries.push({ type: "header", label: "Plugins" });
    // A contributed section is a feature the user came looking for ("Sync"); a plugin's own
    // group is where they go to tune one plugin. The first kind leads.
    const contributed = plugins.filter((s) => s.addedBy).sort(
      (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.label.localeCompare(b.label),
    );
    for (const s of contributed) entries.push({ type: "group", section: s });
    for (const s of plugins) if (!s.addedBy) entries.push({ type: "group", section: s });
    for (const l of loading) entries.push({ type: "loading", label: l });
  }
  return entries;
}

// Only "group" rows are selectable, nav skips headers AND loading placeholders.
export function firstSelectableIndex(entries: SettingsEntry[]): number {
  for (let i = 0; i < entries.length; i++) if (entries[i].type === "group") return i;
  return 0;
}
