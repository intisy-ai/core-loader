// @ts-nocheck
// Settings page rendering: global ecosystem settings editor (config/settings.json).
// Mirrors the mcp.ts structure: list view with cursor, delegates to the shared
// pconfig/pcfginput overlay (already rendered by plugins.ts buildPlugins) for editing.

import { RST, BOLD, DIM, GRAY, WHITE, GREEN, RED, OK, BG_SEL, stringWidth, pad, trunc, ACCENT, rule } from "../format.js";
import { S } from "../state.js";
import { GLOBAL_SETTINGS_DEFAULTS, loadGlobalSettings } from "../config.js";
import { buildConfigItems } from "../plugins.js";
import { hints, messageLine } from "./common.js";

export function buildSettings(pushBody, pushFoot, cols, barW, pushSticky) {
  // The pconfig/pcfginput overlay is rendered here (same markup as plugin configure).
  // handleSettingsKey enters "pconfig" mode and sets S.configTarget = { global: true }.
  if (S.mode === "pconfig" || S.mode === "pcfginput") {
    var ct = S.configTarget;
    var cname = (ct && ct.name) || "settings";
    pushBody("  " + BOLD + WHITE + "Configure " + trunc(cname, cols - 16) + RST, false);
    pushBody("  " + GRAY + "changes save to config/settings.json (restart to apply)" + RST, false);
    pushBody("", false);
    var keyW = 6;
    for (var ck = 0; ck < S.configItems.length; ck++) keyW = Math.max(keyW, stringWidth(S.configItems[ck].key));
    keyW = Math.min(keyW, Math.max(12, Math.floor(cols / 2)));
    for (var ci = 0; ci < S.configItems.length; ci++) {
      var it = S.configItems[ci];
      var csel = ci === S.cfgcursor;
      var editing = S.mode === "pcfginput" && csel;
      var valStr;
      if (editing) valStr = BG_SEL + " " + S.inputBuf + BOLD + "|" + RST;
      else if (it.type === "boolean") valStr = (it.value ? OK + "true" : GRAY + "false") + RST;
      else valStr = WHITE + JSON.stringify(it.value) + RST;
      var mark = it.isSet ? "" : (GRAY + " (default)" + RST);
      var carrow = csel ? (ACCENT + " ❯ " + RST) : "   ";
      var cbg = csel ? BG_SEL : "";
      var cNameStyle = csel ? (BOLD + WHITE) : DIM;
      pushBody("  " + cbg + carrow + cNameStyle + pad(trunc(it.key, keyW), keyW) + RST + cbg + "  " + valStr + mark + RST, csel);
    }
    pushBody("", false);
    if (S.message) pushFoot(messageLine(cols));
    pushFoot("  " + rule(barW));
    if (S.mode === "pcfginput") pushFoot(hints([["enter", "save"], ["esc", "cancel"]]));
    else pushFoot(hints([["↑↓", "move"], ["enter", "edit/toggle"], ["esc", "back"]]));
    return;
  }

  // List view: show every global setting key with its current value.
  var items = buildConfigItems({ defaults: GLOBAL_SETTINGS_DEFAULTS, current: loadGlobalSettings() });

  pushSticky("  " + BOLD + WHITE + "Global Settings" + RST);
  pushSticky("  " + DIM + "Ecosystem-wide settings stored in config/settings.json" + RST);
  pushSticky("");

  if (items.length === 0) {
    pushBody("  " + GRAY + "No global settings defined." + RST, false);
  } else {
    var keyW = 6;
    for (var ki = 0; ki < items.length; ki++) keyW = Math.max(keyW, stringWidth(items[ki].key));
    keyW = Math.min(keyW, Math.max(12, Math.floor(cols / 2)));
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var sel = i === S.settingsCursor;
      var arrow = sel ? (ACCENT + " ❯ " + RST) : "   ";
      var bg = sel ? BG_SEL : "";
      var nameStyle = sel ? (BOLD + WHITE) : DIM;
      var valStr;
      if (it.type === "boolean") valStr = (it.value ? OK + "true" : GRAY + "false") + RST;
      else valStr = WHITE + JSON.stringify(it.value) + RST;
      var mark = it.isSet ? "" : (GRAY + " (default)" + RST);
      pushBody("  " + bg + arrow + nameStyle + pad(trunc(it.key, keyW), keyW) + RST + bg + "  " + valStr + mark + RST, sel);
    }
  }

  pushBody("", false);
  if (S.message) pushFoot(messageLine(cols));
  pushFoot("  " + rule(barW));
  pushFoot(hints([["↑↓", "move"], ["enter", "edit/toggle"], ["?", "help"], ["q", "quit"]]));
}
