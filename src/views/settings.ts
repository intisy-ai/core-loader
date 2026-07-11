// @ts-nocheck
// Settings page rendering: unified editor for the global ecosystem settings
// (config/settings.json) PLUS every plugin's own settings, grouped into sections
// with config-ledger modified-vs-repo markers when config-ledger is installed. Delegates
// to the shared pconfig/pcfginput overlay (also used by plugins.ts) for editing.

import { RST, BOLD, DIM, GRAY, WHITE, OK, BAD, BG_SEL, stringWidth, pad, trunc, ACCENT, rule } from "../format.js";
import { S } from "../state.js";
import { buildGlobalSection, buildPluginSections, annotateModified, buildSettingsEntries, firstSelectableIndex } from "../settings-model.js";
import { configLedgerInstalled, configLedgerReady, getConfigLedger, buildDiffSet, diffKeyId } from "../config-ledger.js";
import { hints, messageLine } from "./common.js";
import { buildSettingsGit } from "./settings-git.js";

// Rebuild the unified section/row model: the global section plus one section per
// plugin that answers `config schema`, flattened into header+item rows with
// modified-vs-repo flags (recomputed from config-ledger's diff when the repo is ready).
export function refreshSettings(): void {
  const sections = [buildGlobalSection()];
  const plugins = (S.pluginItems && S.pluginItems.length) ? S.pluginItems : [];
  for (const sec of buildPluginSections(plugins)) sections.push(sec);

  // Cache readiness once here (git subprocess) so the render path never spawns git per frame.
  S.clReady = configLedgerReady();

  let diffSet = new Set<string>();
  if (S.clReady) {
    try { S.clDiffRows = getConfigLedger().diffAgainstHead() || []; } catch { S.clDiffRows = []; }
    diffSet = buildDiffSet(S.clDiffRows);
  } else {
    S.clDiffRows = [];
  }
  annotateModified(sections, diffSet);   // stamp each group's modified-key count for its badge
  S.settingsSections = sections;
  // entries = the flat list both the renderer and key handler walk (headers + groups +
  // an install entry when config-ledger is absent). Headers aren't selectable.
  S.settingsEntries = buildSettingsEntries(sections, !configLedgerInstalled());
  var cur = S.settingsEntries[S.settingsCursor];
  if (!cur || cur.type === "header") S.settingsCursor = firstSelectableIndex(S.settingsEntries);
}

export function buildSettings(pushBody, pushFoot, cols, barW, pushSticky) {
  // config-ledger sub-screens reached from the Settings tab (git action menu, setting-
  // level diff review, per-setting history, profiles picker, repo setup).
  if (S.mode === "sgmenu" || S.mode === "sgdiff" || S.mode === "sghistory" ||
      S.mode === "sgprofiles" || S.mode === "sgprofinput" || S.mode === "sgsetup" || S.mode === "sgurlinput") {
    buildSettingsGit(pushBody, pushFoot, cols, barW, pushSticky);
    return;
  }

  // The pconfig/pcfginput overlay is rendered here (same markup as plugin configure).
  // handleSettingsKey enters "pconfig" mode and sets S.configTarget = { global: true }.
  if (S.mode === "pconfig" || S.mode === "pcfginput") {
    var ct = S.configTarget;
    var cname = (ct && ct.name) || "settings";
    var cfile = (ct && ct.file) || "settings.json";
    pushBody("  " + BOLD + WHITE + "Configure " + trunc(cname, cols - 16) + RST, false);
    pushBody("  " + GRAY + "changes save to config/" + cfile + " (restart to apply)" + RST, false);
    pushBody("", false);
    var dset = (S.clReady && S.clDiffRows && S.clDiffRows.length) ? buildDiffSet(S.clDiffRows) : null;
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
      var modified = dset && dset.has(diffKeyId(cfile, it.key));
      var mark = modified ? (BAD + " ●" + RST) : (it.isSet ? "" : (GRAY + " (default)" + RST));
      var carrow = csel ? (ACCENT + " ❯ " + RST) : "   ";
      var cbg = csel ? BG_SEL : "";
      var cNameStyle = csel ? (BOLD + WHITE) : DIM;
      pushBody("  " + cbg + carrow + cNameStyle + pad(trunc(it.key, keyW), keyW) + RST + cbg + "  " + valStr + mark + RST, csel);
    }
    pushBody("", false);
    if (S.message) pushFoot(messageLine(cols));
    pushFoot("  " + rule(barW));
    if (S.mode === "pcfginput") pushFoot(hints([["enter", "save"], ["esc", "cancel"]]));
    else if (S.clReady) pushFoot(hints([["↑↓", "move"], ["enter", "edit/toggle"], ["h", "history"], ["esc", "back"]]));
    else pushFoot(hints([["↑↓", "move"], ["enter", "edit/toggle"], ["esc", "back"]]));
    return;
  }

  // Group list: "Global" and "Plugins" sections (BOLD headers, nav skips them), each
  // group Enter-drills into its editor. When config-ledger is absent a "Versioning"
  // section holds a selectable install row — select + Enter installs it, matching how
  // the rest of the app installs things (no bespoke key). No giant flat scroll.
  if (!S.settingsEntries || !S.settingsEntries.length) refreshSettings();

  var cg = configLedgerInstalled();
  if (cg && S.clReady) {
    var m = getConfigLedger();
    var branch = "", remote = "";
    try { branch = m.repo.currentBranch(); } catch (e) {}
    try { remote = m.repo.hasRemote() ? m.repo.getRemote() : "(no remote)"; } catch (e) { remote = "(no remote)"; }
    var dirty = (S.clDiffRows && S.clDiffRows.length) ? (BAD + S.clDiffRows.length + " uncommitted" + RST) : (OK + "clean" + RST);
    pushSticky("  " + BOLD + WHITE + "Settings" + RST + DIM + "  config-ledger " + RST + ACCENT + branch + RST + DIM + "  " + RST + remote + DIM + "  " + RST + dirty);
  } else if (cg) {
    pushSticky("  " + BOLD + WHITE + "Settings" + RST + DIM + "  config-ledger installed — press " + RST + ACCENT + "g" + RST + DIM + " to set up the repo" + RST);
  } else {
    pushSticky("  " + BOLD + WHITE + "Settings" + RST);
  }
  pushSticky("");

  var nameW = 6;
  for (var wi = 0; wi < S.settingsEntries.length; wi++) {
    var we = S.settingsEntries[wi];
    if (we.type === "group") nameW = Math.max(nameW, stringWidth(we.section.label));
    else if (we.type === "install") nameW = Math.max(nameW, stringWidth("config-ledger"));
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
    if (en.type === "group") {
      var sec = en.section;
      var n = sec.items.length;
      var count = n + (n === 1 ? " setting" : " settings");
      var badge = (cg && S.clReady && sec.modifiedCount) ? ("  " + BAD + "● " + sec.modifiedCount + RST) : "";
      pushBody("  " + bg + arrow + nameStyle + pad(trunc(sec.label, nameW), nameW) + RST + bg + "  " + GRAY + pad(count, 12) + RST + badge + RST, sel);
    } else {
      // install row (config-ledger absent): status icon + name + hint, with a selected sub-line
      pushBody("  " + bg + arrow + GRAY + "○ " + RST + nameStyle + pad(trunc("config-ledger", nameW), nameW) + RST + bg + "  " + DIM + "not installed · enter to install" + RST, sel);
      if (sel) pushBody("  " + GRAY + "       versioned config snapshots · history · rollback · profiles" + RST, sel);
    }
  }

  pushBody("", false);
  if (S.message) pushFoot(messageLine(cols));
  pushFoot("  " + rule(barW));
  if (cg && S.clReady) {
    pushFoot(hints([["↑↓", "move"], ["enter", "open"], ["g", "git"], ["p", "profiles"], ["?", "help"], ["q", "quit"]]));
  } else if (cg) {
    pushFoot(hints([["↑↓", "move"], ["enter", "open"], ["g", "setup"], ["?", "help"], ["q", "quit"]]));
  } else {
    pushFoot(hints([["↑↓", "move"], ["enter", "select"], ["?", "help"], ["q", "quit"]]));
  }
}
