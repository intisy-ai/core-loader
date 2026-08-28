// Settings tab: the global + plugin settings list, plus one sub-page per contributed
// screen. Plugin declarations are read in the BACKGROUND (async) with a spinner, so
// entering the tab never blocks; plugin rows show "loading…" until their declaration lands.

import { RST, BOLD, DIM, GRAY, WHITE, OK, BG_SEL, stringWidth, pad, trunc, ACCENT, rule, secretMask, entryMask, isBooleanRowOn } from "../format.js";
import { S } from "../state.js";
import { tuiLog } from "../env.js";
import { buildGlobalSection, buildSettingsEntries, firstSelectableIndex, splitBySections } from "../settings-model.js";
import { declarationFor, readDeclaration, settingsPluginIds } from "../plugins.js";
import { hints, messageLine, spinnerFrame, scheduleRender } from "./common.js";
import { collectScreens, subPages, buildContributedScreen } from "./screens.js";
import type { PushBody, PushFoot, PushSticky } from "./common.js";
import type { SettingsRow } from "../settings-model.js";

// An action row carries a human label; a setting row is addressed by its key.
function rowLabel(row: SettingsRow): string {
  return row.kind === "action" ? row.label : row.key;
}

/**
 * Every sub-page of the Settings tab, in tab-bar/Tab-cycle order: Settings, then one per
 * contributed screen.
 */
export function settingsSubPages() {
  return subPages(collectScreens());
}

// Rebuild the section model + entry list from ALREADY-READ declarations only. A plugin whose
// declaration is still outstanding becomes a "loading" placeholder; this never starts a read.
function buildSectionsFromCache() {
  const sections = [buildGlobalSection()];
  const loading = [];
  for (const pluginId of settingsPluginIds()) {
    const declaration = declarationFor(pluginId);
    if (declaration === undefined) { loading.push(pluginId); continue; }
    if (declaration) sections.push(...splitBySections(declaration));
  }
  S.settingsSections = sections;
  S.settingsEntries = buildSettingsEntries(sections, loading);
  var cur = S.settingsEntries[S.settingsCursor];
  if (!cur || cur.type !== "group") S.settingsCursor = firstSelectableIndex(S.settingsEntries);
}

// Read any declaration not yet cached. S.catalogPending drives the shared spinner (updateSpinner in
// render); scheduleRender coalesces the burst of redraws. The in-flight set is local because a
// declaration's cache entry only appears once the read finishes.
var READING = new Set();

function readSettingsDeclarations() {
  for (const pluginId of settingsPluginIds()) {
    if (declarationFor(pluginId) !== undefined || READING.has(pluginId)) continue;
    READING.add(pluginId);
    S.catalogPending++;
    // The bookkeeping and the redraw run in their own link, so a rejected read or a throw while
    // rebuilding still releases this plugin and still repaints: stranded, its row would spin for the
    // rest of the session and never be read again.
    readDeclaration(pluginId).then(function () {
      buildSectionsFromCache();
    }).catch(function (error) {
      tuiLog("rebuilding the settings tab for " + pluginId + " failed: " + String(error), true);
    }).then(function () {
      READING.delete(pluginId);
      S.catalogPending = Math.max(0, S.catalogPending - 1);
      scheduleRender();
    });
  }
}

/** Rebuilds the Settings page's sections and rows from what has been read so far. */
export function refreshSettings(): void {
  buildSectionsFromCache();
  readSettingsDeclarations();
}

/** Draws the Settings page, or whichever contributed screen is showing. */
export function buildSettings(pushBody: PushBody, pushFoot: PushFoot, cols: number, barW: number, pushSticky: PushSticky): void {
  var sub = S.settingsSubPage || "settings";
  var pages = settingsSubPages();

  // Sub-tab bar (Settings | one per contributed screen) + a blank line,
  // shown only at the list level.
  if (S.mode === "list") {
    var tabsStr = pages.map(function (p) {
      return p.id === sub ? (BOLD + ACCENT + BG_SEL + " " + p.label + " " + RST) : (GRAY + " " + p.label + " " + RST);
    }).join("  ");
    pushSticky("  " + tabsStr + "    " + DIM + "tab switch" + RST);
    pushSticky("");
  }

  if (sub !== "settings") {
    var page = pages.find(function (p) { return p.id === sub; });
    buildContributedScreen(pushBody, pushFoot, cols, barW, pushSticky, page && page.entry);
    return;
  }

  // --- Settings sub-tab ---
  if (S.mode === "pconfig" || S.mode === "pcfginput" || S.mode === "pcfgargs") {
    var ct = S.configTarget;
    var cname = (ct && ct.name) || "settings";
    var cfile = (ct && ct.file) || "settings.json";
    pushBody("  " + BOLD + WHITE + "Configure " + trunc(cname, cols - 16) + RST, false);
    var origin = (ct && ct.addedBy) ? ("added by " + ct.addedBy + " · ") : "";
    pushBody("  " + GRAY + origin + "changes save to config/" + cfile + " (restart to apply)" + RST, false);
    pushBody("", false);
    var keyW = 6;
    for (var ck = 0; ck < S.configItems.length; ck++) keyW = Math.max(keyW, stringWidth(rowLabel(S.configItems[ck])));
    keyW = Math.min(keyW, Math.max(12, Math.floor(cols / 2)));
    for (var ci = 0; ci < S.configItems.length; ci++) {
      var it = S.configItems[ci];
      var csel = ci === S.cfgcursor;
      var editing = S.mode === "pcfginput" && csel;
      var valStr;
      var mark = "";
      if (it.kind === "action") {
        // While an action's declared args are being collected, its row IS the prompt: one arg at a
        // time, in the value column the rest of the editor already types into.
        var collecting = S.configActionArgs && S.configActionArgs.key === it.key ? S.configActionArgs : null;
        if (collecting) {
          var argSpec = collecting.specs[collecting.at] || {};
          valStr = BG_SEL + " " + (argSpec.label || argSpec.key) + ": " + S.inputBuf + BOLD + "|" + RST;
        } else valStr = (S.configConfirm === it.key ? (ACCENT + (it.confirm || "Run this?") + " enter to confirm") : (GRAY + "↵ run")) + RST;
      } else {
        if (editing) valStr = BG_SEL + " " + (it.type === "secret" ? entryMask(S.inputBuf) : S.inputBuf) + BOLD + "|" + RST;
        else if (it.type === "boolean") valStr = (isBooleanRowOn(it.value) ? OK + "true" : GRAY + "false") + RST;
        else if (it.type === "secret" && S.cfgReveal !== it.key) valStr = GRAY + secretMask(it.value) + RST;
        else valStr = WHITE + JSON.stringify(it.value) + RST;
        mark = it.isSet ? "" : (GRAY + " (default)" + RST);
      }
      var carrow = csel ? (ACCENT + " ❯ " + RST) : "   ";
      var cbg = csel ? BG_SEL : "";
      var cNameStyle = csel ? (BOLD + WHITE) : DIM;
      pushBody("  " + cbg + carrow + cNameStyle + pad(trunc(rowLabel(it), keyW), keyW) + RST + cbg + "  " + valStr + mark + RST, csel);
    }
    pushBody("", false);
    if (S.message) pushFoot(messageLine(cols));
    pushFoot("  " + rule(barW));
    var hasSecret = S.configItems.some(function (row: SettingsRow) { return row.kind !== "action" && row.type === "secret"; });
    if (S.mode === "pcfgargs") {
      var pending = S.configActionArgs;
      var last = !pending || pending.at >= pending.specs.length - 1;
      pushFoot(hints([["enter", last ? "run" : "next"], ["esc", "cancel"]]));
    }
    else if (S.mode === "pcfginput") pushFoot(hints([["enter", "save"], ["esc", "cancel"]]));
    else pushFoot(hints(hasSecret ? [["↑↓", "move"], ["enter", "edit/toggle/run"], ["r", "reveal"], ["esc", "back"]] : [["↑↓", "move"], ["enter", "edit/toggle/run"], ["esc", "back"]]));
    return;
  }

  // Group list.
  if (!S.settingsEntries || !S.settingsEntries.length) refreshSettings();

  var nameW = 6;
  for (var wi = 0; wi < S.settingsEntries.length; wi++) {
    var we = S.settingsEntries[wi];
    if (we.type === "group") nameW = Math.max(nameW, stringWidth(we.section.label));
    else if (we.type === "loading") nameW = Math.max(nameW, stringWidth(we.label));
  }
  nameW = Math.min(nameW, Math.max(16, Math.floor(cols / 2)));

  for (var i = 0; i < S.settingsEntries.length; i++) {
    var en = S.settingsEntries[i];
    if (en.type === "header") {
      if (i > 0) pushBody("", false);   // blank line before each section header (except the first)
      pushBody("  " + BOLD + WHITE + en.label + RST, false);
      continue;
    }
    if (en.type === "loading") {
      pushBody("     " + spinnerFrame() + " " + DIM + pad(trunc(en.label, nameW), nameW) + RST + "  " + GRAY + "loading…" + RST, false);
      continue;
    }
    var sel = i === S.settingsCursor;
    var arrow = sel ? (ACCENT + " ❯ " + RST) : "   ";
    var bg = sel ? BG_SEL : "";
    var nameStyle = sel ? (BOLD + WHITE) : DIM;
    var sec = en.section;
    var n = sec.items.length;
    var count = n + (n === 1 ? " control" : " controls");
    var by = sec.addedBy ? (GRAY + "  added by " + sec.addedBy + RST) : "";
    pushBody("  " + bg + arrow + nameStyle + pad(trunc(sec.label, nameW), nameW) + RST + bg + "  " + GRAY + pad(count, 12) + RST + by, sel);
  }

  pushBody("", false);
  if (S.message) pushFoot(messageLine(cols));
  pushFoot("  " + rule(barW));
  pushFoot(hints([["↑↓", "move"], ["enter", "open"], ["tab", "switch"], ["?", "help"], ["q", "quit"]]));
}
