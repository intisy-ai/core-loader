// @ts-nocheck
// The Versioning tab — git-backed config versioning (config-ledger). All git lives here;
// the Settings tab is git-free. Three top-level states, chosen by config-ledger status:
//   • not installed  → a single install gate (Enter installs, like the Plugins updater gate)
//   • not initialized → the repo setup screen (Initialize / connect remote / gh)
//   • ready           → the version-control home (review+commit / push / pull / history / profiles / setup)
// Drill-in sub-screens (diff review, history file→key pickers + timeline, profiles, inputs)
// are rendered here too, keyed by S.mode.
import { S } from "../state.js";
import { RST, BOLD, DIM, GRAY, WHITE, ACCENT, INFO, OK, BAD, BG_SEL, pad, trunc, stringWidth, rule } from "../format.js";
import { hints, updaterInstallProgress } from "./common.js";
import { configLedgerInstalled, configLedgerReady, getConfigLedger, resolveConfigLedgerLib, preloadConfigLedger } from "../config-ledger.js";
import { render } from "./render.js";

// The version-control home actions. `diff` also drives commit/import (the review screen).
export const VG_MENU_ITEMS = [
  { key: "diff", label: "Review & commit changes", desc: "see uncommitted settings; commit or import" },
  { key: "push", label: "Push to remote", desc: "publish commits to the git remote" },
  { key: "pull", label: "Pull from remote", desc: "fetch and apply remote commits" },
  { key: "history", label: "History & rollback", desc: "view a setting's past values, roll one back" },
  { key: "profiles", label: "Profiles (branches)", desc: "switch between config profiles" },
  { key: "setup", label: "Repo setup / remote", desc: "re-seed, set remote, create GitHub repo" },
];

// Setup options — shared by the not-initialized default view and the "setup" sub-mode.
export function versioningSetupOpts() {
  const m = S.CONFIG_LEDGER_MODULE;
  let ready = false, gh = false;
  try { ready = m && m.repo.isRepo(); } catch {}
  try { gh = m && m.setup.ghAvailable(); } catch {}
  const opts = [
    { key: "init", label: ready ? "Re-seed from current config" : "Initialize repository",
      desc: ready ? "snapshot the current config onto a new commit" : "create the repo + snapshot current config" },
    { key: "remote", label: "Connect a remote…", desc: "paste a git URL (https/ssh) to push & pull" },
  ];
  if (gh) opts.push({ key: "gh", label: "Create a private GitHub repo", desc: "via the gh CLI — creates it and connects" });
  return opts;
}

// Recompute config-ledger readiness + the uncommitted-diff rows for this tab. Called on
// entering the tab and after every mutating action (commit/import/pull/rollback/switch/init)
// — never per render frame (isRepo/diffAgainstHead spawn git).
export function refreshVersioning() {
  S.clReady = configLedgerReady();
  if (S.clReady) { try { S.clDiffRows = getConfigLedger().diffAgainstHead() || []; } catch { S.clDiffRows = []; } }
  else S.clDiffRows = [];
}

// Live install/uninstall detection: config-ledger can be added/removed from the Plugins
// tab (or externally) while the TUI is open. Reconcile the cached lib module against what
// is actually on disk so the Versioning sub-tab flips between gate ⇄ setup/home without a
// restart. Called on entering the sub-tab; async because (re)importing the lib is async.
export async function reconcileConfigLedger() {
  const libPath = resolveConfigLedgerLib();
  if (!libPath && S.CONFIG_LEDGER_MODULE) {
    S.CONFIG_LEDGER_MODULE = null;   // uninstalled while open → fall back to the gate
    refreshVersioning();
    render();
    return;
  }
  if (libPath && !S.CONFIG_LEDGER_MODULE) {
    await preloadConfigLedger();      // freshly installed while open → light up the tab
    refreshVersioning();
    render();
    return;
  }
  refreshVersioning();
}

function renderMenu(pushBody, items, cursor) {
  var nameW = 6;
  for (var j = 0; j < items.length; j++) nameW = Math.max(nameW, stringWidth(items[j].label));
  for (var i = 0; i < items.length; i++) {
    var sel = i === cursor;
    var arrow = sel ? (ACCENT + " ❯ " + RST) : "   ";
    var bg = sel ? BG_SEL : "";
    var style = sel ? (BOLD + WHITE) : DIM;
    pushBody("  " + bg + arrow + style + pad(items[i].label, nameW) + RST + bg + "  " + GRAY + (items[i].desc || "") + RST, sel);
  }
}

function statusSticky(pushSticky) {
  const m = getConfigLedger();
  let branch = "", remote = "";
  try { branch = m.repo.currentBranch(); } catch (e) {}
  try { remote = m.repo.hasRemote() ? m.repo.getRemote() : "(no remote)"; } catch (e) { remote = "(no remote)"; }
  const dirty = (S.clDiffRows && S.clDiffRows.length) ? (BAD + S.clDiffRows.length + " uncommitted" + RST) : (OK + "clean" + RST);
  pushSticky("  " + BOLD + WHITE + "Versioning" + RST + DIM + "  " + RST + ACCENT + branch + RST + DIM + "  " + RST + remote + DIM + "  " + RST + dirty);
}

export function buildVersioning(pushBody, pushFoot, cols, barW, pushSticky) {
  // Installing plugin-updater (the prerequisite) — identical screen to the Plugins tab.
  if (S.updaterInstalling) { updaterInstallProgress(pushBody, pushFoot, barW); return; }

  // Drill-in sub-screens.
  if (S.mode === "sgdiff" || S.mode === "sghistory" || S.mode === "sgprofiles" || S.mode === "sgprofinput"
      || S.mode === "sgsetup" || S.mode === "sgurlinput" || S.mode === "vghfiles" || S.mode === "vghkeys") {
    buildVersioningSub(pushBody, pushFoot, cols, barW, pushSticky);
    return;
  }

  // ① Not installed → a full-tab install gate, same shape as the Plugins tab's updater
  // gate. Arrow keys still switch tabs (handled in handleKey before this handler) — the
  // gate is scoped to this tab, it doesn't trap the whole UI.
  if (!configLedgerInstalled()) {
    pushBody("  " + BOLD + WHITE + "Config Versioning Not Installed" + RST, false);
    pushBody("  Track your configuration in git — history, rollback, profiles, and sync across machines.", false);
    pushBody("", false);
    pushBody("  Press " + BOLD + WHITE + "Enter" + RST + " to install it (config-ledger). Nothing else here is available until it is.", false);
    pushFoot("  " + rule(barW));
    pushFoot(hints([["enter", "install"], ["tab", "switch"], ["q", "quit"]]));
    return;
  }

  // ② Installed but not initialized → the redesigned setup screen (default view here).
  if (!configLedgerReady()) {
    pushSticky("  " + BOLD + WHITE + "Versioning" + RST + DIM + "  ·  config-ledger installed, not initialized" + RST);
    pushSticky("");
    pushBody("  " + GRAY + "Initialize a local repo to start versioning your config; connect a remote" + RST, false);
    pushBody("  " + GRAY + "to sync across machines (optional)." + RST, false);
    pushBody("", false);
    pushBody("  " + BOLD + WHITE + "Setup" + RST, false);
    var sopts = versioningSetupOpts();
    S._sgSetupOpts = sopts;
    renderMenu(pushBody, sopts, S.versioningCursor);
    pushBody("", false);
    pushFoot("  " + rule(barW));
    pushFoot(hints([["↑↓", "move"], ["enter", "select"], ["tab", "switch"], ["?", "help"], ["q", "quit"]]));
    return;
  }

  // ③ Ready → the version-control home.
  statusSticky(pushSticky);
  pushSticky("");
  pushBody("  " + BOLD + WHITE + "Actions" + RST, false);
  var items = VG_MENU_ITEMS.map(function (it) {
    if (it.key !== "diff") return it;
    var n = (S.clDiffRows && S.clDiffRows.length) || 0;
    return { key: "diff", label: it.label, desc: n ? (n + " uncommitted") : "clean" };
  });
  S._vgMenuItems = items;
  renderMenu(pushBody, items, S.versioningCursor);
  pushBody("", false);
  pushFoot("  " + rule(barW));
  pushFoot(hints([["↑↓", "move"], ["enter", "select"], ["tab", "switch"], ["?", "help"], ["q", "quit"]]));
}

function buildVersioningSub(pushBody, pushFoot, cols, barW, pushSticky) {
  if (S.mode === "sgdiff") {
    var rows = S.clDiffRows || [];
    pushSticky("  " + BOLD + WHITE + "Uncommitted changes" + RST + DIM + "  " + rows.length + " setting(s)" + RST);
    pushSticky("");
    if (!rows.length) {
      pushBody("  " + GRAY + "In sync with repo HEAD — nothing to commit." + RST, false);
    } else {
      var fileW = 6;
      for (var wi = 0; wi < rows.length; wi++) fileW = Math.max(fileW, (rows[wi].file + " " + rows[wi].key).length);
      fileW = Math.min(fileW, Math.max(20, Math.floor(cols * 0.5)));
      for (var ri = 0; ri < rows.length; ri++) {
        var r = rows[ri];
        pushBody("  " + INFO + pad(trunc(r.file + " " + r.key, fileW), fileW) + RST + "  " + GRAY + r.old + RST + DIM + " → " + RST + WHITE + r.new + RST, false);
      }
    }
    pushFoot("  " + rule(barW));
    pushFoot(hints([["c", "commit (live → repo)"], ["i", "import (repo → live)"], ["esc", "back"]]));
    return;
  }
  if (S.mode === "vghfiles") {
    pushSticky("  " + BOLD + WHITE + "History" + RST + DIM + "  ·  pick a config file" + RST);
    pushSticky("");
    var secs = S.vgSections || [];
    for (var fi = 0; fi < secs.length; fi++) {
      var fsel = fi === S.vgFileCursor;
      pushBody("  " + (fsel ? BG_SEL : "") + (fsel ? (ACCENT + " ❯ " + RST + BG_SEL) : "   ") + (fsel ? BOLD + WHITE : DIM) + secs[fi].file + RST, fsel);
    }
    pushFoot("  " + rule(barW));
    pushFoot(hints([["↑↓", "move"], ["enter", "pick file"], ["esc", "back"]]));
    return;
  }
  if (S.mode === "vghkeys") {
    pushSticky("  " + BOLD + WHITE + "History" + RST + DIM + "  ·  " + S.vgHistFile + " — pick a setting" + RST);
    pushSticky("");
    var keys = S.vgKeys || [];
    if (!keys.length) pushBody("  " + GRAY + "No settings in this file." + RST, false);
    for (var ki = 0; ki < keys.length; ki++) {
      var ksel = ki === S.vgKeyCursor;
      pushBody("  " + (ksel ? BG_SEL : "") + (ksel ? (ACCENT + " ❯ " + RST + BG_SEL) : "   ") + (ksel ? BOLD + WHITE : DIM) + keys[ki] + RST, ksel);
    }
    pushFoot("  " + rule(barW));
    pushFoot(hints([["↑↓", "move"], ["enter", "view history"], ["esc", "back"]]));
    return;
  }
  if (S.mode === "sghistory") {
    pushSticky("  " + BOLD + WHITE + "History" + RST + DIM + "  " + S.clHistoryFile + " " + S.clHistoryKey + RST);
    pushSticky("");
    var hist = S.clHistory || [];
    if (!hist.length) {
      pushBody("  " + GRAY + "No recorded history for this setting." + RST, false);
    } else {
      for (var hi = 0; hi < hist.length; hi++) {
        var h = hist[hi];
        var hsel = hi === S.clHistoryCursor;
        var val = (h.value === undefined || h.value === null) ? "(unset)" : JSON.stringify(h.value);
        pushBody("  " + (hsel ? BG_SEL : "") + (hsel ? (ACCENT + " ❯ " + RST) : "   ") + (hsel ? BG_SEL : "") + DIM + String(h.date) + RST + (hsel ? BG_SEL : "") + "  " + GRAY + String(h.hash).slice(0, 7) + RST + (hsel ? BG_SEL : "") + "  " + WHITE + trunc(val, Math.max(20, cols - 40)) + RST, hsel);
      }
    }
    pushFoot("  " + rule(barW));
    pushFoot(hints([["↑↓", "move"], ["enter", "roll back to this value"], ["esc", "back"]]));
    return;
  }
  if (S.mode === "sgprofiles" || S.mode === "sgprofinput") {
    pushSticky("  " + BOLD + WHITE + "Profiles" + RST + DIM + "  branches of the config repo" + RST);
    pushSticky("");
    var profs = S.clProfiles || [];
    for (var pi = 0; pi < profs.length; pi++) {
      var psel = pi === S.clProfileCursor && S.mode === "sgprofiles";
      var cur = profs[pi] === S.clProfileCurrent ? (OK + " (current)" + RST) : "";
      pushBody("  " + (psel ? BG_SEL : "") + (psel ? (ACCENT + " ❯ " + RST + BG_SEL) : "   ") + (psel ? BOLD + WHITE : DIM) + profs[pi] + RST + cur, psel);
    }
    if (S.mode === "sgprofinput") {
      pushBody("", false);
      pushBody("  " + INFO + "New profile name: " + RST + WHITE + (S.inputBuf || "") + RST + ACCENT + "|" + RST, false);
    }
    pushFoot("  " + rule(barW));
    pushFoot(S.mode === "sgprofinput"
      ? hints([["enter", "create + switch"], ["esc", "cancel"]])
      : hints([["↑↓", "move"], ["enter", "switch (review import)"], ["n", "new profile"], ["esc", "back"]]));
    return;
  }
  if (S.mode === "sgsetup" || S.mode === "sgurlinput") {
    var m = S.CONFIG_LEDGER_MODULE;
    var remote = "";
    try { remote = m && m.repo.hasRemote() ? m.repo.getRemote() : "(none)"; } catch { remote = "(none)"; }
    pushSticky("  " + BOLD + WHITE + "Repo setup" + RST + DIM + "  remote: " + RST + WHITE + remote + RST);
    pushSticky("");
    var opts = versioningSetupOpts();
    S._sgSetupOpts = opts;
    renderMenu(pushBody, opts, S.sgSetupCursor);
    if (S.mode === "sgurlinput") {
      pushBody("", false);
      pushBody("  " + INFO + "Remote URL: " + RST + WHITE + (S.inputBuf || "") + RST + ACCENT + "|" + RST, false);
    }
    pushFoot("  " + rule(barW));
    pushFoot(S.mode === "sgurlinput"
      ? hints([["enter", "save remote"], ["esc", "cancel"]])
      : hints([["↑↓", "move"], ["enter", "select"], ["esc", "back"]]));
    return;
  }
}
