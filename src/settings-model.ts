// Pure builder for the unified Settings tab: assembles the global settings section
// plus one section per plugin that has a config schema. The Settings tab renders
// these sections as a drill-in list (Global + one row per plugin); Enter opens a
// section's own editor. annotateModified stamps each section with the count of keys
// that differ from the config-ledger repo HEAD (for the per-group modified badge).
import { probeConfigSchema, buildConfigItems } from "./plugins.js";
import { GLOBAL_SETTINGS_DEFAULTS, loadGlobalSettings } from "./config.js";
import { diffKeyId } from "./config-ledger.js";

export type SettingsItem = { key: string; value: unknown; def: unknown; isSet: boolean; type: string };
export type SettingsSection = {
  label: string;
  kind: "global" | "plugin";
  file: string;
  bundle: string | null;
  items: SettingsItem[];
  modifiedCount?: number;   // # of items differing from repo HEAD (0 when config-ledger absent)
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

// Count, per section, how many of its keys appear in the config-ledger diff set.
// Mutates each section's modifiedCount and returns the same array.
export function annotateModified(sections: SettingsSection[], diffSet: Set<string>): SettingsSection[] {
  for (const sec of sections) {
    let n = 0;
    for (const it of sec.items) if (diffSet.has(diffKeyId(sec.file, it.key))) n++;
    sec.modifiedCount = n;
  }
  return sections;
}

// One flat, ordered list the renderer AND the key handler both walk (the loader's
// parallel-array convention). When config-ledger is absent a single "install" prompt
// leads (styled like the Plugins tab's updater prompt — one Enter installs it, pulling
// in plugin-updater first if needed). Settings then split under "Global" / "Plugins"
// headers so the two kinds read distinctly. Headers are not selectable — nav skips them.
export type SettingsEntry =
  | { type: "header"; label: string }
  | { type: "group"; section: SettingsSection }
  | { type: "install" };

export function buildSettingsEntries(sections: SettingsSection[], installable: boolean): SettingsEntry[] {
  const entries: SettingsEntry[] = [];
  if (installable) entries.push({ type: "install" });   // single top prompt, no category
  const globals = sections.filter((s) => s.kind === "global");
  const plugins = sections.filter((s) => s.kind === "plugin");
  if (globals.length) {
    entries.push({ type: "header", label: "Global" });
    for (const s of globals) entries.push({ type: "group", section: s });
  }
  if (plugins.length) {
    entries.push({ type: "header", label: "Plugins" });
    for (const s of plugins) entries.push({ type: "group", section: s });
  }
  return entries;
}

export function firstSelectableIndex(entries: SettingsEntry[]): number {
  for (let i = 0; i < entries.length; i++) if (entries[i].type !== "header") return i;
  return 0;
}
