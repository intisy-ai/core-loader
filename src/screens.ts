// Rendering a plugin's contributed screen as terminal rows. The flatten walk itself comes from
// core, so this surface and the graphical dashboard collapse the same tree the same way.
import { flattenScreen, screenLayoutFor } from "@intisy-ai/core";
import type { ActionSpec, FlatRow, ScreenSpec } from "@intisy-ai/core";

export { flattenScreen, CONTAINER_KINDS, MAX_LAYOUT_DEPTH } from "@intisy-ai/core";
export type { FlatRow, ScreenNode, ScreenSpec } from "@intisy-ai/core";

/** One flattened row of a contributed screen, as the terminal draws it. */
export interface ScreenRow {
  /** The line to print, label included. */
  text: string;
  /** How deeply nested the node was, which is what the row is indented by. */
  depth: number;
  /** The action this row runs when it is chosen. */
  actionId?: string;
  /** The entry id that action is run against. */
  argId?: string;
}

/** One contributed screen, together with the plugin that declared it and that plugin's actions. */
export interface ScreenEntry {
  /** The plugin that declared the screen. */
  plugin: string;
  /** What it declared. */
  spec: ScreenSpec;
  /**
   * The action metadata for the rows the screen produces.
   *
   * @remarks
   * It comes from the plugin's SETTINGS declaration, which is where the api keeps `ActionSpec`, so
   * a screen-only action id simply resolves to nothing here and still runs, without its label.
   */
  actions: ActionSpec[];
}

function label(row: FlatRow): string {
  return row.label ? row.label + ": " : "";
}

function cells(entry: Record<string, unknown>, keys: string[]): string {
  return keys.map((key) => String(entry[key] ?? "")).filter(Boolean).join("  ");
}

// Node kinds this flattener has no row shape for at all, regardless of whether data has
// loaded: unlike a table/list/chips block (which is just empty until its source arrives),
// these never produce a source-array row, so staying silent would make them vanish rather
// than degrade.
const UNAVAILABLE_TUI_KINDS = new Set(["form", "fields", "actions", "meter"]);

/**
 * One row per collection entry, because a terminal list is the only shape this surface has.
 * A block whose source is empty contributes its declared empty text instead of nothing, so a
 * reader can tell "no snapshots yet" from "this block failed to load".
 */
export function screenRows(spec: ScreenSpec, sources: Record<string, unknown>): ScreenRow[] {
  const out: ScreenRow[] = [];
  for (const row of flattenScreen(screenLayoutFor(spec, "tui"))) {
    const node = row.node;
    if (node.kind === "text" || node.kind === "banner") {
      const text = typeof node.text === "string" ? node.text : String(sources[node.source as string] ?? "");
      if (text) out.push({ text: label(row) + text, depth: row.depth });
      continue;
    }
    if (UNAVAILABLE_TUI_KINDS.has(node.kind)) {
      out.push({ text: label(row) + "Not available in the terminal.", depth: row.depth });
      continue;
    }
    const entries = Array.isArray(sources[node.source as string]) ? (sources[node.source as string] as Record<string, unknown>[]) : null;
    if (!entries) continue;
    if (!entries.length) {
      out.push({ text: label(row) + (typeof node.empty === "string" ? node.empty : "Nothing to show."), depth: row.depth });
      continue;
    }
    for (const entry of entries) {
      const keys = node.kind === "table" && Array.isArray(node.columns)
        ? (node.columns as { key: string }[]).map((column) => column.key)
        : ["label", "subject", "value", "id"];
      const actionId = Array.isArray(node.rowActions) ? (node.rowActions[0] as string) : (node.select as string | undefined);
      out.push({ text: label(row) + cells(entry, keys), depth: row.depth, ...(actionId ? { actionId, argId: String(entry.id ?? "") } : {}) });
    }
  }
  return out;
}
