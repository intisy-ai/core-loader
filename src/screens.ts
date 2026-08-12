// Re-implements core's screen-layout.ts flatten rule (libs/core/src/screen-layout.ts) so a
// contributed screen renders the same way in this TUI as it does in the graphical dashboard.
// core-loader carries no core submodule by design, so the walk is copied here verbatim and the
// two implementations are kept honest by asserting against the same fixture file.

export interface ScreenNode {
  kind: string;
  children?: ScreenNode[];
  [prop: string]: unknown;
}

export interface ScreenSpec {
  id: string;
  label: string;
  layout: ScreenNode;
  surfaces?: { tui?: ScreenNode };
}

export interface FlatRow {
  kind: string;
  label?: string;
  node: ScreenNode;
  depth: number;
}

export const CONTAINER_KINDS = new Set(["stack", "row", "grid", "card", "group", "tabs"]);

interface Tab {
  id?: string;
  label?: string;
  child?: ScreenNode;
}

function titleOf(node: ScreenNode): string | undefined {
  const title = node.title ?? node.label;
  return typeof title === "string" && title ? title : undefined;
}

function join(outer: string | undefined, inner: string | undefined): string | undefined {
  if (outer && inner) return `${outer} / ${inner}`;
  return outer ?? inner;
}

function walk(node: ScreenNode, depth: number, label: string | undefined, rows: FlatRow[]): void {
  if (!CONTAINER_KINDS.has(node.kind)) {
    rows.push(label === undefined ? { kind: node.kind, node, depth } : { kind: node.kind, label, node, depth });
    return;
  }
  const own = join(label, titleOf(node));
  if (node.kind === "tabs") {
    const tabs = Array.isArray(node.tabs) ? (node.tabs as Tab[]) : [];
    for (const tab of tabs) {
      if (tab && tab.child) walk(tab.child, depth + 1, join(own, tab.label), rows);
    }
    return;
  }
  for (const child of node.children ?? []) walk(child, depth + 1, own, rows);
}

export function flattenScreen(node: ScreenNode): FlatRow[] {
  const rows: FlatRow[] = [];
  walk(node, CONTAINER_KINDS.has(node.kind) ? -1 : 0, undefined, rows);
  return rows;
}

function screenLayoutFor(spec: ScreenSpec, surface: "gui" | "tui"): ScreenNode {
  return (surface === "tui" && spec.surfaces?.tui) || spec.layout;
}

export interface ScreenRow {
  text: string;
  depth: number;
  actionId?: string;
  argId?: string;
}

function label(row: FlatRow): string {
  return row.label ? row.label + ": " : "";
}

function cells(entry: Record<string, unknown>, keys: string[]): string {
  return keys.map((key) => String(entry[key] ?? "")).filter(Boolean).join("  ");
}

// One row per collection entry, because a terminal list is the only shape this surface has.
// A block whose source is empty contributes its declared empty text instead of nothing, so a
// reader can tell "no snapshots yet" from "this block failed to load".
export function screenRows(spec: ScreenSpec, sources: Record<string, unknown>): ScreenRow[] {
  const out: ScreenRow[] = [];
  for (const row of flattenScreen(screenLayoutFor(spec, "tui"))) {
    const node = row.node;
    const entries = Array.isArray(sources[node.source as string]) ? (sources[node.source as string] as Record<string, unknown>[]) : null;
    if (node.kind === "text" || node.kind === "banner") {
      const text = typeof node.text === "string" ? node.text : String(sources[node.source as string] ?? "");
      if (text) out.push({ text: label(row) + text, depth: row.depth });
      continue;
    }
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
