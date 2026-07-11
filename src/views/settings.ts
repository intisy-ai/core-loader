// @ts-nocheck
// Settings page rendering: unified editor for the global ecosystem settings
// (config/settings.json) PLUS every plugin's own settings, grouped into sections
// with config-git modified-vs-repo markers when config-git is installed. Delegates
// to the shared pconfig/pcfginput overlay (also used by plugins.ts) for editing.

import { RST, BOLD, DIM, GRAY, WHITE, OK, BAD, INFO, BG_SEL, stringWidth, pad, trunc, ACCENT, rule } from "../format.js";
import { S } from "../state.js";
import { buildGlobalSection, buildPluginSections, flattenRows, firstItemIndex } from "../settings-model.js";
import { configGitInstalled, configGitReady, getConfigGit, buildDiffSet } from "../config-git.js";
import { hints, messageLine } from "./common.js";
import { buildSettingsGit } from "./settings-git.js";

// Rebuild the unified section/row model: the global section plus one section per
// plugin that answers `config schema`, flattened into header+item rows with
// modified-vs-repo flags (recomputed from config-git's diff when the repo is ready).
export function refreshSettings(): void {
  const sections = [buildGlobalSection()];
  const plugins = (S.pluginItems && S.pluginItems.length) ? S.pluginItems : [];
  for (const sec of buildPluginSections(plugins)) sections.push(sec);
  S.settingsSections = sections;

  let diffSet = new Set<string>();
  if (configGitReady()) {
    try { S.cgDiffRows = getConfigGit().diffAgainstHead() || []; } catch { S.cgDiffRows = []; }
    diffSet = buildDiffSet(S.cgDiffRows);
  } else {
    S.cgDiffRows = [];
  }
  S.settingsRows = flattenRows(sections, diffSet);
  // clamp cursor to a valid item row
  if (!S.settingsRows[S.settingsCursor] || S.settingsRows[S.settingsCursor].type !== "item") {
    S.settingsCursor = firstItemIndex(S.settingsRows);
  }
}

export function buildSettings(pushBody, pushFoot, cols, barW, pushSticky) {
  // config-git sub-screens reached from the Settings tab (git action menu, setting-
  // level diff review, per-setting history). Profiles/setup modes join this dispatch
  // in Task 6.
  if (S.mode === "sgmenu" || S.mode === "sgdiff" || S.mode === "sghistory") {
    buildSettingsGit(pushBody, pushFoot, cols, barW, pushSticky);
    return;
  }

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

  // List view: unified global + per-plugin settings rows.
  if (!S.settingsRows || !S.settingsRows.length) refreshSettings();

  var cg = configGitInstalled();
  if (cg && configGitReady()) {
    var m = getConfigGit();
    var branch = "", remote = "";
    try { branch = m.repo.currentBranch(); } catch (e) {}
    try { remote = m.repo.hasRemote() ? m.repo.getRemote() : "(no remote)"; } catch (e) { remote = "(no remote)"; }
    var dirty = (S.cgDiffRows && S.cgDiffRows.length) ? (BAD + S.cgDiffRows.length + " uncommitted" + RST) : (OK + "clean" + RST);
    pushSticky("  " + BOLD + WHITE + "Settings" + RST + DIM + "  config-git " + RST + ACCENT + branch + RST + DIM + "  " + RST + remote + DIM + "  " + RST + dirty);
  } else if (cg) {
    pushSticky("  " + BOLD + WHITE + "Settings" + RST + DIM + "  config-git installed — press " + RST + ACCENT + "g" + RST + DIM + " to set up the repo" + RST);
  } else {
    pushSticky("  " + BOLD + WHITE + "Settings" + RST + DIM + "  global + plugin settings (install config-git for versioning)" + RST);
  }
  pushSticky("");

  // column width from the widest key across all sections
  var keyW = 6;
  for (var wi = 0; wi < S.settingsRows.length; wi++) {
    var wr = S.settingsRows[wi];
    if (wr.type === "item") keyW = Math.max(keyW, stringWidth(wr.item.key));
  }
  keyW = Math.min(keyW, Math.max(12, Math.floor(cols / 2)));

  for (var i = 0; i < S.settingsRows.length; i++) {
    var r = S.settingsRows[i];
    if (r.type === "header") {
      pushBody("  " + BOLD + INFO + r.label + RST, false);
      continue;
    }
    var it = r.item;
    var sel = i === S.settingsCursor;
    var arrow = sel ? (ACCENT + " ❯ " + RST) : "   ";
    var bg = sel ? BG_SEL : "";
    var nameStyle = sel ? (BOLD + WHITE) : DIM;
    var valStr;
    if (it.type === "boolean") valStr = (it.value ? OK + "true" : GRAY + "false") + RST;
    else valStr = WHITE + JSON.stringify(it.value) + RST;
    var marker = r.modified ? (BAD + " ●" + RST) : (it.isSet ? "" : (GRAY + " (default)" + RST));
    pushBody("    " + bg + arrow + nameStyle + pad(trunc(it.key, keyW), keyW) + RST + bg + "  " + valStr + marker + RST, sel);
  }

  pushBody("", false);
  if (S.message) pushFoot(messageLine(cols));
  pushFoot("  " + rule(barW));
  if (cg && configGitReady()) {
    pushFoot(hints([["↑↓", "move"], ["enter", "edit"], ["h", "history"], ["g", "git"], ["p", "profiles"], ["?", "help"], ["q", "quit"]]));
  } else if (cg) {
    pushFoot(hints([["↑↓", "move"], ["enter", "edit"], ["g", "setup"], ["?", "help"], ["q", "quit"]]));
  } else {
    pushFoot(hints([["↑↓", "move"], ["enter", "edit"], ["?", "help"], ["q", "quit"]]));
  }
}
