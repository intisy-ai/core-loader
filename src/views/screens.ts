// @ts-nocheck
// Contributed screens as one more Settings sub-page. A plugin declares a whole screen
// (Task 14's flattenScreen/screenRows turn that declaration into rows); this module
// collects those declarations, orders them into sub-pages, and fills S.screenRows by
// running the owning plugin's bundle in a CHILD PROCESS (never in-process), so a
// slow/missing/broken plugin blocks that child and never the render loop.

import { execFile } from "child_process";
import { S } from "../state.js";
import { CONFIG_DIR, tuiLog } from "../env.js";
import { spawnEnv } from "../activity-seam.js";
import { screenRows } from "../screens.js";
import { RST, BOLD, DIM, GRAY, WHITE, BG_SEL, ACCENT, rule } from "../format.js";
import { hints, messageLine, scheduleRender } from "./common.js";

export function collectScreens(pluginItems) {
  const out = [];
  for (const item of pluginItems || []) {
    const screens = (item && item._cfg && item._cfg.screens) || [];
    const actions = (item && item._cfg && item._cfg.actions) || [];
    for (const spec of screens) out.push({ plugin: (item._cfg && item._cfg.name) || item.name, spec, actions });
  }
  return out;
}

// Declared metadata (label/confirm/danger) for a screen row's action id, the terminal's
// analogue of what the dashboard's Actions.svelte resolves. An id the plugin never declared
// (a screen-only action) still has to run, just without that metadata.
export function resolveScreenAction(entry, actionId) {
  const actions = (entry && entry.actions) || [];
  return actions.find((a) => a && a.id === actionId) || { id: actionId, label: actionId };
}

// The sub-page id a screen renders under, shared by subPages (which assigns it) and
// refreshScreen's staleness guard (which must agree on the same id to detect "the user
// tabbed away before this response landed").
export function entryId(entry) {
  return entry && entry.spec ? entry.plugin + ":" + entry.spec.id : null;
}

export function subPages(entries) {
  const sorted = entries.slice().sort(
    (a, b) => (a.spec.order ?? Number.MAX_SAFE_INTEGER) - (b.spec.order ?? Number.MAX_SAFE_INTEGER) || a.spec.label.localeCompare(b.spec.label),
  );
  return [{ id: "settings", label: "Settings" }].concat(sorted.map((entry) => ({ id: entryId(entry), label: entry.spec.label, entry })));
}

// The deployed bundle backing a contributed screen's plugin, resolved from the already-
// probed pluginItems cache (declarationOf stashes it as _cfg.bundle). Not carried on the
// screen entry itself: collectScreens's shape is asserted exactly by its test.
function bundleFor(pluginName) {
  var items = S.pluginItems || [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var name = it && it._cfg && (it._cfg.name || it.name);
    if (it && it._cfg && it._cfg.bundle && name === pluginName) return it._cfg.bundle;
  }
  return null;
}

// A read is expected back quickly. 10000 matches the dashboard's own uiProbe.ts budget for
// the same protocol against the same bundle, so a plugin does not work in one surface and
// time out in the other. An invoke may do real work (a multi-file restore, a network
// round-trip): execFile's timeout SIGTERMs the child on expiry, so an invoke budget as short
// as the read's would kill legitimate work mid-write with no atomicity guarantee. 600000
// matches runPluginAction's own action timeout in plugins.ts, the directly analogous case.
var UI_DATA_TIMEOUT_MS = 10000;
var UI_INVOKE_TIMEOUT_MS = 600000;

// node <bundle> ui data <screenId> --home <CONFIG_DIR> answers { sources }. Runs async
// via execFile (a real child process with its own timeout), so a hung plugin never
// blocks this event loop; the caller keeps rendering "loading" until the callback lands.
export function refreshScreen(entry) {
  if (!entry || !entry.spec) return;
  var bundle = bundleFor(entry.plugin);
  if (!bundle) { tuiLog("screen " + entry.plugin + ":" + entry.spec.id + " has no resolvable bundle", true); return; }
  var pageId = entryId(entry);
  execFile(process.execPath, [bundle, "ui", "data", entry.spec.id, "--home", CONFIG_DIR],
    { timeout: UI_DATA_TIMEOUT_MS, windowsHide: true, env: spawnEnv() },
    function (err, stdout) {
      if (err) { tuiLog("screen " + entry.spec.id + " refresh failed: " + ((err && err.message) || err), true); return; }
      var data;
      try { data = JSON.parse(String(stdout).trim()); }
      catch (e) { tuiLog("screen " + entry.spec.id + " returned unparseable data: " + e, true); return; }
      // Stale guard: the user may have tabbed to a different sub-page while this child
      // process was running (this can take up to UI_DATA_TIMEOUT_MS, or longer still when
      // it was kicked off by a refresh:true action answer under UI_INVOKE_TIMEOUT_MS).
      // Only the still-active screen's rows may land, or they'd render under the wrong header.
      if (S.settingsSubPage !== pageId) return;
      S.screenRows = screenRows(entry.spec, (data && data.sources) || {});
      scheduleRender();
    });
}

// node <bundle> ui invoke <actionId> --home <CONFIG_DIR> --args <json> answers
// { ok, message?, refresh? }. done always receives that shape (synthesized on a spawn
// or parse failure) so the caller can flash `message` uniformly either way.
export function runScreenAction(entry, row, done) {
  var finish = typeof done === "function" ? done : function () {};
  if (!entry || !entry.spec || !row || !row.actionId) { finish({ ok: false, message: "nothing to run" }); return; }
  var bundle = bundleFor(entry.plugin);
  if (!bundle) { tuiLog("screen action " + row.actionId + " has no resolvable bundle for " + entry.plugin, true); finish({ ok: false, message: "plugin not available" }); return; }
  var args = row.argId !== undefined ? { id: row.argId } : {};
  execFile(process.execPath, [bundle, "ui", "invoke", row.actionId, "--home", CONFIG_DIR, "--args", JSON.stringify(args)],
    { timeout: UI_INVOKE_TIMEOUT_MS, windowsHide: true, env: spawnEnv() },
    function (err, stdout) {
      if (err) {
        var msg = (err && err.message) || String(err);
        tuiLog("screen action " + row.actionId + " failed: " + msg, true);
        finish({ ok: false, message: msg });
        return;
      }
      var answer;
      try { answer = JSON.parse(String(stdout).trim()); }
      catch (e) { tuiLog("screen action " + row.actionId + " returned unparseable data: " + e, true); finish({ ok: false, message: "invalid response" }); return; }
      if (answer && answer.refresh) refreshScreen(entry);
      finish(answer);
    });
}

// One row per flattened screen node, indented by its depth; a row carrying an actionId
// is the only kind that can be selected/run (S.screenCursor only ever rests on one).
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
