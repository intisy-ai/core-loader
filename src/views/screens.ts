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
    for (const spec of screens) out.push({ plugin: (item._cfg && item._cfg.name) || item.name, spec });
  }
  return out;
}

export function subPages(entries) {
  const sorted = entries.slice().sort(
    (a, b) => (a.spec.order ?? Number.MAX_SAFE_INTEGER) - (b.spec.order ?? Number.MAX_SAFE_INTEGER) || a.spec.label.localeCompare(b.spec.label),
  );
  return [{ id: "settings", label: "Settings" }].concat(sorted.map((entry) => ({ id: entry.plugin + ":" + entry.spec.id, label: entry.spec.label, entry })));
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

var SCREEN_TIMEOUT_MS = 8000;

// node <bundle> ui data <screenId> --home <CONFIG_DIR> answers { sources }. Runs async
// via execFile (a real child process with its own timeout), so a hung plugin never
// blocks this event loop; the caller keeps rendering "loading" until the callback lands.
export function refreshScreen(entry) {
  if (!entry || !entry.spec) return;
  var bundle = bundleFor(entry.plugin);
  if (!bundle) { tuiLog("screen " + entry.plugin + ":" + entry.spec.id + " has no resolvable bundle", true); return; }
  execFile(process.execPath, [bundle, "ui", "data", entry.spec.id, "--home", CONFIG_DIR],
    { timeout: SCREEN_TIMEOUT_MS, windowsHide: true, env: spawnEnv() },
    function (err, stdout) {
      if (err) { tuiLog("screen " + entry.spec.id + " refresh failed: " + ((err && err.message) || err), true); return; }
      var data;
      try { data = JSON.parse(String(stdout).trim()); }
      catch (e) { tuiLog("screen " + entry.spec.id + " returned unparseable data: " + e, true); return; }
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
    { timeout: SCREEN_TIMEOUT_MS, windowsHide: true, env: spawnEnv() },
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
