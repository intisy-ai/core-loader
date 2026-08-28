// Pure builder for the Settings tab: assembles the global settings section plus one
// section per plugin declaring something configurable, then the flat entry list the renderer
// and key handler both walk: a "Global" header + its group, then a "Plugins" header + one
// group row per plugin. Headers are not selectable (nav skips them).
import { byOrderThenLabel } from "@intisy-ai/core";
import type { FieldOption, FieldSpec } from "@intisy-ai/core";
import { buildConfigItems, declarationFor, settingsPluginIds } from "./plugins.js";
import type { PluginDeclaration } from "./plugins.js";
import type { ActionSpec } from "./capability-shapes.js";
import { GLOBAL_SETTINGS_DEFAULTS, loadGlobalSettings } from "./config.js";
import { S } from "./state.js";

/** One editable setting: its value, its default, and whether the file actually holds it. */
export type SettingsItem = {
  /**
   * Never set on a setting.
   *
   * @remarks
   * Declared so the union with {@link SettingsAction} is discriminated: without it, a renderer
   * testing `row.kind === "action"` narrows nothing and reads every other field off the union.
   */
  kind?: undefined;
  /** The key it is stored under, which may be a dot path into a nested object. */
  key: string;
  /** Its effective value. */
  value: unknown;
  /** Its declared default. */
  def: unknown;
  /** Whether the file holds it, as opposed to it merely defaulting. */
  isSet: boolean;
  /** How it is edited, from the declaration when there is one and from the value otherwise. */
  type: string;
  /** The choices it steps through, when the declaration named a list. */
  options?: FieldOption[];
};
export type SettingsAction = { kind: "action"; key: string; label: string; description?: string; confirm?: string; danger?: boolean; args?: FieldSpec[] };
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

/**
 * What the config editor is currently editing: one section, plus how to write it back.
 *
 * @remarks
 * Built from a settings section or from a plugin's own declaration, which is why `plugin` and
 * `global` are alternatives rather than both required.
 */
export type ConfigTarget = {
  /** The heading the editor shows. */
  name: string;
  /** The plugin this section belongs to, absent on the global one. */
  plugin?: string;
  /** Set on the global section, which is written directly rather than through a plugin. */
  global?: boolean;
  /** The bundle an action is run through, when there is one. */
  bundle?: string | null;
  /** The config file being edited, which the editor header names. */
  file: string;
  /** The rows being edited. */
  items: SettingsRow[];
  /** The plugin that CONTRIBUTED this section, when it is not the plugin that owns the file. */
  addedBy?: string;
  /** The contributed section's id, which is how it is re-resolved after a write. */
  sectionId?: string;
};

/**
 * The host loader injects core's own declaration of the shared settings (defaults plus
 * field types), so a key core adds shows up here with no change. The local constant is
 * only the fallback for a host that injects nothing.
 */
export function buildGlobalSection(): SettingsSection {
  const injected = S.capabilities.globalSettings || null;
  const defaults = (injected && injected.defaults) || GLOBAL_SETTINGS_DEFAULTS;
  const fields = (injected && injected.fields) || [];
  const items = buildConfigItems({ defaults, fields, current: loadGlobalSettings() });
  return { label: "Global", kind: "global", file: "settings.json", bundle: null, items };
}

/**
 * The config file a declaration edits. This is read back as a real path (the editor header names it,
 * and any surface reading a plugin's config must name the same file), so it follows the config name
 * the plugin reports for ITSELF, never the id surfaces route by. One helper, so a second caller cannot drift.
 */
export function configFileFor(cfg: PluginDeclaration | null | undefined): string {
  return ((cfg && cfg.configName) || (cfg && cfg.name)) + ".json";
}

function actionRow(action: ActionSpec): SettingsAction {
  const row: SettingsAction = { kind: "action", key: action.id, label: action.label };
  if (typeof action.description === "string") row.description = action.description;
  if (typeof action.confirm === "string") row.confirm = action.confirm;
  if (action.danger === true) row.danger = true;
  // What the action needs collected before it runs. Carried through so the editor can prompt: an
  // action whose args never reach it runs on nothing, which is a plugin's action silently misfiring.
  if (Array.isArray(action.args) && action.args.length) row.args = action.args;
  return row;
}

/**
 * The claim rule, applied to this surface's flat rows: a setting or action NAMED by a
 * contributed section belongs to that section, and whatever no section claimed stays the
 * plugin's own group. A section that claims nothing resolvable is dropped rather than
 * listed empty.
 */
export function splitBySections(cfg: PluginDeclaration): SettingsSection[] {
  const name = cfg.name;
  const file = configFileFor(cfg);
  const itemByKey = new Map<string, SettingsRow>((cfg.items || []).map((i: SettingsItem) => [i.key, i]));
  const actionById = new Map<string, ActionSpec>((cfg.actions || []).map((a: ActionSpec) => [a.id, a]));
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

/**
 * Only declarations already read: this runs on a render path, so it never starts a capability call
 * or a child process of its own.
 */
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

/**
 * `sections` holds only resolved groups (Global + plugins with settings); `loading` holds the
 * ids of plugins whose declaration is still being read in the background (rendered with a spinner).
 */
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
    const contributed = plugins.filter((s) => s.addedBy).sort(byOrderThenLabel);
    for (const s of contributed) entries.push({ type: "group", section: s });
    for (const s of plugins) if (!s.addedBy) entries.push({ type: "group", section: s });
    for (const l of loading) entries.push({ type: "loading", label: l });
  }
  return entries;
}

/** Only "group" rows are selectable, nav skips headers AND loading placeholders. */
export function firstSelectableIndex(entries: SettingsEntry[]): number {
  for (let i = 0; i < entries.length; i++) if (entries[i].type === "group") return i;
  return 0;
}
