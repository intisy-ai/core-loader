// @ts-nocheck
// Settings page: editor for the global ecosystem settings (config/settings.json) PLUS
// every plugin's own settings, grouped under "Global" / "Plugins" headers. Enter drills
// into a group's editor (the shared pconfig/pcfginput overlay, also used by plugins.ts).
// Git/versioning is NOT here — it lives in its own Versioning tab (views/versioning.ts).

import { RST, BOLD, DIM, GRAY, WHITE, OK, BG_SEL, stringWidth, pad, trunc, ACCENT, rule } from "../format.js";
import { S } from "../state.js";
import { buildGlobalSection, buildPluginSections, buildSettingsEntries, firstSelectableIndex } from "../settings-model.js";
import { hints, messageLine } from "./common.js";

// Rebuild the section model (Global + one section per plugin that answers `config schema`)
// and the flat entry list (headers + group rows) the renderer and key handler both walk.
export function refreshSettings(): void {
  const sections = [buildGlobalSection()];
  const plugins = (S.pluginItems && S.pluginItems.length) ? S.pluginItems : [];
  for (const sec of buildPluginSections(plugins)) sections.push(sec);
  S.settingsSections = sections;
  S.settingsEntries = buildSettingsEntries(sections);
  var cur = S.settingsEntries[S.settingsCursor];
  if (!cur || cur.type === "header") S.settingsCursor = firstSelectableIndex(S.settingsEntries);
}

export function buildSettings(pushBody, pushFoot, cols, barW, pushSticky) {
  // The pconfig/pcfginput editor overlay (same markup as plugin configure). handleSettingsKey
  // enters "pconfig" and sets S.configTarget for the chosen group (global or a plugin).
  if (S.mode === "pconfig" || S.mode === "pcfginput") {
    var ct = S.configTarget;
    var cname = (ct && ct.name) || "settings";
    var cfile = (ct && ct.file) || "settings.json";
    pushBody("  " + BOLD + WHITE + "Configure " + trunc(cname, cols - 16) + RST, false);
    pushBody("  " + GRAY + "changes save to config/" + cfile + " (restart to apply)" + RST, false);
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

  // Group list: "Global" and "Plugins" sections (BOLD headers, nav skips them); each group
  // Enter-drills into its editor.
  if (!S.settingsEntries || !S.settingsEntries.length) refreshSettings();

  pushSticky("  " + BOLD + WHITE + "Settings" + RST + DIM + "  global + plugin settings" + RST);
  pushSticky("");

  var nameW = 6;
  for (var wi = 0; wi < S.settingsEntries.length; wi++) {
    var we = S.settingsEntries[wi];
    if (we.type === "group") nameW = Math.max(nameW, stringWidth(we.section.label));
  }
  nameW = Math.min(nameW, Math.max(16, Math.floor(cols / 2)));

  for (var i = 0; i < S.settingsEntries.length; i++) {
    var en = S.settingsEntries[i];
    if (en.type === "header") {
      if (i > 0) pushBody("", false);   // blank line before each section header (except the first)
      pushBody("  " + BOLD + WHITE + en.label + RST, false);
      continue;
    }
    var sel = i === S.settingsCursor;
    var arrow = sel ? (ACCENT + " ❯ " + RST) : "   ";
    var bg = sel ? BG_SEL : "";
    var nameStyle = sel ? (BOLD + WHITE) : DIM;
    var sec = en.section;
    var n = sec.items.length;
    var count = n + (n === 1 ? " setting" : " settings");
    pushBody("  " + bg + arrow + nameStyle + pad(trunc(sec.label, nameW), nameW) + RST + bg + "  " + GRAY + pad(count, 12) + RST, sel);
  }

  pushBody("", false);
  if (S.message) pushFoot(messageLine(cols));
  pushFoot("  " + rule(barW));
  pushFoot(hints([["↑↓", "move"], ["enter", "open"], ["?", "help"], ["q", "quit"]]));
}
