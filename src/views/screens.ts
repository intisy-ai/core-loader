// @ts-nocheck
// Contributed screens as one more Settings sub-page. A plugin declares whole screens through the
// `screens` capability; this module caches those declarations, orders them into sub-pages, and
// fills S.screenRows from the capability's own read and invoke calls. Both calls run under a
// deadline (plugin-surface.ts), so a plugin that never answers costs its own sub-page and nothing
// else. A plugin doing synchronous CPU work still blocks this event loop: no deadline can preempt
// that, and it is the cost the in-process contract accepts.

import { S } from "../state.js";
import { screenRows } from "../screens.js";
import { invokeScreenAction, providerIds, readScreenData, readScreenSpecs, readSettingsSchema } from "../plugin-surface.js";
import { RST, BOLD, DIM, GRAY, WHITE, BG_SEL, ACCENT, rule } from "../format.js";
import { hints, messageLine, scheduleRender } from "./common.js";

// Read once into S.screenSpecs: screens() may be async and the sub-page list is walked on every
// render frame. A row's action metadata comes from the same plugin's settings declaration, which is
// where api keeps ActionSpec. Plugins are read concurrently (each one's two reads stay ordered,
// since the second is skipped when the first declared no screen) because this runs at boot, where a
// plugin that answers slowly must not delay the ones that answer at once. Promise.all preserves
// order, so the sub-page order is still the order the host activated the plugins in.
export async function refreshScreenSpecs() {
  const perPlugin = await Promise.all(providerIds("screens").map(async function (pluginId) {
    const specs = await readScreenSpecs(pluginId);
    if (!specs.length) return [];
    const schema = await readSettingsSchema(pluginId);
    const actions = (schema && Array.isArray(schema.actions)) ? schema.actions : [];
    return specs
      .filter((spec) => spec && typeof spec.id === "string" && typeof spec.label === "string")
      .map((spec) => ({ plugin: pluginId, spec, actions }));
  }));
  S.screenSpecs = perPlugin.flat();
}

export function collectScreens(specs) {
  const entries = specs || S.screenSpecs || [];
  return entries.map((entry) => ({ plugin: entry.plugin, spec: entry.spec, actions: entry.actions || [] }));
}

// Declared metadata (label/confirm/danger) for a screen row's action id, the terminal's analogue of
// what the dashboard's Actions.svelte resolves. An id the plugin never declared (a screen-only
// action) still has to run, just without that metadata.
export function resolveScreenAction(entry, actionId) {
  const actions = (entry && entry.actions) || [];
  return actions.find((a) => a && a.id === actionId) || { id: actionId, label: actionId };
}

// The sub-page id a screen renders under, shared by subPages (which assigns it) and refreshScreen's
// staleness guard (which must agree on the same id to detect "the user tabbed away before this
// response landed").
export function entryId(entry) {
  return entry && entry.spec ? entry.plugin + ":" + entry.spec.id : null;
}

export function subPages(entries) {
  const sorted = entries.slice().sort(
    (a, b) => (a.spec.order ?? Number.MAX_SAFE_INTEGER) - (b.spec.order ?? Number.MAX_SAFE_INTEGER) || a.spec.label.localeCompare(b.spec.label),
  );
  return [{ id: "settings", label: "Settings" }].concat(sorted.map((entry) => ({ id: entryId(entry), label: entry.spec.label, entry })));
}

export function refreshScreen(entry) {
  if (!entry || !entry.spec) return;
  const pageId = entryId(entry);
  readScreenData(entry.plugin, entry.spec.id).then(function (sources) {
    if (sources === null) return;
    // The user may have tabbed to a different sub-page while the read was outstanding. Only the
    // still-active screen's rows may land, or they would render under the wrong header.
    if (S.settingsSubPage !== pageId) return;
    S.screenRows = screenRows(entry.spec, sources);
    scheduleRender();
  });
}

// done always receives an ActionResult shape, so the caller can flash `message` whether the action
// ran, refused or failed.
export function runScreenAction(entry, row, done) {
  const finish = typeof done === "function" ? done : function () {};
  if (!entry || !entry.spec || !row || !row.actionId) { finish({ ok: false, message: "nothing to run" }); return; }
  const input = row.argId !== undefined ? { id: row.argId } : {};
  invokeScreenAction(entry.plugin, entry.spec.id, row.actionId, input).then(function (answer) {
    if (answer && answer.refresh) refreshScreen(entry);
    finish(answer);
  });
}

// One row per flattened screen node, indented by its depth; a row carrying an actionId is the only
// kind that can be selected/run (S.screenCursor only ever rests on one).
export function buildContributedScreen(pushBody, pushFoot, cols, barW, pushSticky, entry) {
  var label = (entry && entry.spec && entry.spec.label) || "Screen";
  pushSticky("  " + BOLD + WHITE + label + RST);
  pushSticky("");

  var rows = S.screenRows || [];
  if (!entry) {
    pushBody("  " + GRAY + "Screen not found." + RST, false);
  } else if (!rows.length) {
    pushBody("  " + GRAY + "Loading…" + RST, false);
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
