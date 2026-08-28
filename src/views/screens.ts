// Contributed screens as one more Settings sub-page. A plugin declares whole screens through the
// `screens` capability; this module caches those declarations, orders them into sub-pages, and
// fills S.screenRows from the capability's own read and invoke calls. Both calls run under a
// deadline (plugin-surface.ts), so a plugin that never answers costs its own sub-page and nothing
// else. A plugin doing synchronous CPU work still blocks this event loop: no deadline can preempt
// that, and it is the cost the in-process contract accepts.

import { S } from "../state.js";
import { byOrderThenLabel } from "@intisy-ai/core";
import { screenRows } from "../screens.js";
import { tuiLog } from "../env.js";
import { invokeScreenAction, providerIds, readScreenData, readScreenSpecs, readSettingsSchema } from "../plugin-surface.js";
import { RST, BOLD, DIM, GRAY, WHITE, BG_SEL, ACCENT, rule } from "../format.js";
import { hints, messageLine, scheduleRender } from "./common.js";
import { SCREENS } from "@intisy-ai/core";
import type { ActionSpec } from "../capability-shapes.js";
import type { ScreenEntry, ScreenRow } from "../screens.js";
import type { ActionResult } from "../capability-shapes.js";
import type { PushBody, PushFoot, PushSticky } from "./common.js";

/** One sub-page of the Settings tab: the built-in one, or a screen a plugin contributed. */
export interface ScreenSubPage {
  /** Its id, which is `settings` or `<plugin>:<screenId>`. */
  id: string;
  /** What the sub-tab strip shows. */
  label: string;
  /** The contributed screen behind it, absent on the built-in one. */
  entry?: ScreenEntry;
}

// Read once into S.screenSpecs: screens() may be async and the sub-page list is walked on every
// render frame. A row's action metadata comes from the same plugin's settings declaration, which is
// where api keeps ActionSpec. Plugins are read concurrently (each one's two reads stay ordered,
// since the second is skipped when the first declared no screen) because this runs at boot, where a
// plugin that answers slowly must not delay the ones that answer at once. Promise.all preserves
// order, so the sub-page order is still the order the host activated the plugins in.
export async function refreshScreenSpecs() {
  const perPlugin = await Promise.all(providerIds(SCREENS).map(async function (pluginId) {
    const specs = await readScreenSpecs(pluginId);
    if (!specs.length) return [];
    const schema = await readSettingsSchema(pluginId);
    const actions = (schema && Array.isArray(schema.actions)) ? schema.actions : [];
    return specs.map((spec) => ({ plugin: pluginId, spec, actions }));
  }));
  S.screenSpecs = perPlugin.flat();
}

export function collectScreens(specs?: ScreenEntry[] | null): ScreenEntry[] {
  const entries = specs || S.screenSpecs || [];
  return entries.map((entry: ScreenEntry) => ({ plugin: entry.plugin, spec: entry.spec, actions: entry.actions || [] }));
}

// Declared metadata (label/confirm/danger) for a screen row's action id, the terminal's analogue of
// what the dashboard's Actions.svelte resolves. An id the plugin never declared (a screen-only
// action) still has to run, just without that metadata.
export function resolveScreenAction(entry: ScreenEntry | null | undefined, actionId: string): ActionSpec {
  const actions = (entry && entry.actions) || [];
  return actions.find((a: ActionSpec) => a && a.id === actionId) || { id: actionId, label: actionId };
}

// The sub-page id a screen renders under, shared by subPages (which assigns it) and refreshScreen's
// staleness guard (which must agree on the same id to detect "the user tabbed away before this
// response landed").
export function entryId(entry: ScreenEntry | null | undefined): string | null {
  return entry && entry.spec ? entry.plugin + ":" + entry.spec.id : null;
}

export function subPages(entries: ScreenEntry[]): ScreenSubPage[] {
  const sorted = entries.slice().sort((a, b) => byOrderThenLabel(a.spec, b.spec));
  const pages: ScreenSubPage[] = [{ id: "settings", label: "Settings" }];
  return pages.concat(sorted.map((entry) => ({ id: entryId(entry) || "", label: entry.spec.label || entry.spec.id, entry })));
}

// A read that failed renders as itself rather than as a permanent "Loading…": a screen sub-page has
// no refresh key, so the only retry a reader has is leaving the sub-page and coming back.
function markScreenUnreadable(pageId: string | null): void {
  S.screenFailed = pageId;
  S.screenRows = [];
  scheduleRender();
}

export function refreshScreen(entry: ScreenEntry | null | undefined): Promise<void> | undefined {
  if (!entry || !entry.spec) return;
  const pageId = entryId(entry);
  return readScreenData(entry.plugin, entry.spec.id).then(function (sources) {
    // The user may have tabbed to a different sub-page while the read was outstanding. Only the
    // still-active screen's rows may land, or they would render under the wrong header.
    if (S.settingsSubPage !== pageId) return;
    if (sources === null) { markScreenUnreadable(pageId); return; }
    S.screenFailed = null;
    S.screenRows = screenRows(entry.spec, sources);
    scheduleRender();
  }).catch(function (error) {
    tuiLog("screen " + pageId + " could not be rendered: " + String(error), true);
    if (S.settingsSubPage === pageId) markScreenUnreadable(pageId);
  });
}

// done always receives an ActionResult shape, exactly once, on every path including a throw: a
// caller owns whatever it armed before the call (the busy gate) and releases it in there, so
// skipping the call would leave the loader gated on an action nothing will ever report.
export function runScreenAction(entry: ScreenEntry | null | undefined, row: ScreenRow | null | undefined, done?: (answer: ActionResult) => void): Promise<void> | undefined {
  const finish = typeof done === "function" ? done : function () {};
  var reported = false;
  function report(answer: ActionResult): void {
    if (reported) return;
    reported = true;
    finish(answer);
  }
  if (!entry || !entry.spec || !row || !row.actionId) { report({ ok: false, message: "nothing to run" }); return; }
  const input = row.argId !== undefined ? { id: row.argId } : {};
  return invokeScreenAction(entry.plugin, entry.spec.id, row.actionId, input).then(function (answer) {
    if (answer && answer.refresh) refreshScreen(entry);
    report(answer);
  }).catch(function (error) {
    tuiLog("screen action " + row.actionId + " could not be completed: " + String(error), true);
    // A throw from inside done itself already reported, so this cannot re-enter it.
    report({ ok: false, message: "the action could not be completed" });
  });
}

// One row per flattened screen node, indented by its depth; a row carrying an actionId is the only
// kind that can be selected/run (S.screenCursor only ever rests on one).
export function buildContributedScreen(pushBody: PushBody, pushFoot: PushFoot, cols: number, barW: number, pushSticky: PushSticky, entry?: ScreenEntry): void {
  var label = (entry && entry.spec && entry.spec.label) || "Screen";
  pushSticky("  " + BOLD + WHITE + label + RST);
  pushSticky("");

  var rows = S.screenRows || [];
  if (!entry) {
    pushBody("  " + GRAY + "Screen not found." + RST, false);
  } else if (!rows.length) {
    var unreadable = S.screenFailed && S.screenFailed === entryId(entry);
    pushBody("  " + GRAY + (unreadable ? "Could not read this screen. Leave this sub-page and come back to retry." : "Loading…") + RST, false);
  }
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var selectable = !!row.actionId;
    var sel = selectable && i === S.screenCursor;
    var indent = "  " + "  ".repeat(Math.max(0, row.depth || 0));
    var arrow = sel ? (ACCENT + " ❯ " + RST) : (selectable ? "   " : "");
    var bg = sel ? BG_SEL : "";
    var style = sel ? (BOLD + WHITE) : (selectable ? WHITE : DIM);
    pushBody(indent + bg + arrow + style + row.text + RST, sel);
  }
  pushBody("", false);
  if (S.message) pushFoot(messageLine(cols));
  pushFoot("  " + rule(barW));
  var hasActions = rows.some(function (row) { return row.actionId; });
  pushFoot(hasActions
    ? hints([["↑↓", "move"], ["enter", "run"], ["tab", "switch"], ["?", "help"], ["q", "quit"]])
    : hints([["tab", "switch"], ["?", "help"], ["q", "quit"]]));
}
