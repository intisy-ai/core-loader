// Pure builder for the unified Settings tab: assembles the global settings section
// plus one section per plugin that has a config schema, and flattens them into
// render rows (headers + items) with modified-vs-repo flags. No I/O in flattenRows.
import { probeConfigSchema, buildConfigItems } from "./plugins.js";
import { GLOBAL_SETTINGS_DEFAULTS, loadGlobalSettings } from "./config.js";
import { diffKeyId } from "./config-git.js";

export type SettingsItem = { key: string; value: unknown; def: unknown; isSet: boolean; type: string };
export type SettingsSection = { label: string; kind: "global" | "plugin"; file: string; bundle: string | null; items: SettingsItem[] };
export type SettingsRow = {
  type: "header" | "item";
  label?: string;
  sectionIndex: number;
  itemIndex?: number;
  item?: SettingsItem;
  file?: string;
  bundle?: string | null;
  kind?: "global" | "plugin";
  modified: boolean;
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

export function flattenRows(sections: SettingsSection[], diffSet: Set<string>): SettingsRow[] {
  const rows: SettingsRow[] = [];
  for (let s = 0; s < sections.length; s++) {
    const sec = sections[s];
    rows.push({ type: "header", label: sec.label, sectionIndex: s, modified: false });
    for (let i = 0; i < sec.items.length; i++) {
      const it = sec.items[i];
      rows.push({
        type: "item", sectionIndex: s, itemIndex: i, item: it,
        file: sec.file, bundle: sec.bundle, kind: sec.kind,
        modified: diffSet.has(diffKeyId(sec.file, it.key)),
      });
    }
  }
  return rows;
}

export function firstItemIndex(rows: SettingsRow[]): number {
  for (let i = 0; i < rows.length; i++) if (rows[i].type === "item") return i;
  return 0;
}
