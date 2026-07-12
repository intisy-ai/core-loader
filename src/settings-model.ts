// Pure builder for the Settings tab: assembles the global settings section plus one
// section per plugin that has a config schema, then the flat entry list the renderer and
// key handler both walk — a "Global" header + its group, then a "Plugins" header + one
// group row per plugin. Headers are not selectable (nav skips them). Git-free: the
// Versioning tab owns all config-ledger UI.
import { probeConfigSchema, buildConfigItems } from "./plugins.js";
import { GLOBAL_SETTINGS_DEFAULTS, loadGlobalSettings } from "./config.js";

export type SettingsItem = { key: string; value: unknown; def: unknown; isSet: boolean; type: string };
export type SettingsSection = {
  label: string;
  kind: "global" | "plugin";
  file: string;
  bundle: string | null;
  items: SettingsItem[];
};

export function buildGlobalSection(): SettingsSection {
  const items = buildConfigItems({ defaults: GLOBAL_SETTINGS_DEFAULTS, current: loadGlobalSettings() }) as SettingsItem[];
  return { label: "Global", kind: "global", file: "settings.json", bundle: null, items };
}

export function buildPluginSections(pluginItems: any[]): SettingsSection[] {
  const out: SettingsSection[] = [];
  for (const p of pluginItems || []) {
    // reuse a cached probe if the Plugins tab already ran it; else probe now
    let cfg = p && p._cfg;
    if (p && p._cfgProbed !== true) { cfg = probeConfigSchema(p); p._cfg = cfg; p._cfgProbed = true; }
    if (!cfg || !cfg.items || !cfg.items.length) continue;
    const name = cfg.name || p.name;
    out.push({ label: name, kind: "plugin", file: name + ".json", bundle: cfg.bundle, items: cfg.items });
  }
  return out;
}

export type SettingsEntry =
  | { type: "header"; label: string }
  | { type: "group"; section: SettingsSection }
  | { type: "loading"; label: string };   // a plugin whose config schema is still being probed

// `sections` holds only fully-probed groups (Global + plugins with settings); `loading`
// holds the names of plugins still being probed in the background (rendered with a spinner).
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
    for (const s of plugins) entries.push({ type: "group", section: s });
    for (const l of loading) entries.push({ type: "loading", label: l });
  }
  return entries;
}

// Only "group" rows are selectable — nav skips headers AND loading placeholders.
export function firstSelectableIndex(entries: SettingsEntry[]): number {
  for (let i = 0; i < entries.length; i++) if (entries[i].type === "group") return i;
  return 0;
}
