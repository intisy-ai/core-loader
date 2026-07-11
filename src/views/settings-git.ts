// @ts-nocheck
// Renderers for the config-ledger sub-screens reached from the Settings tab:
// the git action menu (sgmenu) and the setting-level diff review (sgdiff).
import { S } from "../state.js";
import { RST, BOLD, DIM, GRAY, WHITE, ACCENT, INFO, OK, BG_SEL, pad, trunc, rule } from "../format.js";
import { hints } from "./common.js";

export const SG_MENU_ITEMS = [
  { key: "commit", label: "Commit pending changes" },
  { key: "diff", label: "Review changes (diff)" },
  { key: "push", label: "Push to remote" },
  { key: "pull", label: "Pull from remote" },
  { key: "profiles", label: "Profiles / branches" },
  { key: "setup", label: "Repo setup (remote / gh)" },
];

export function buildSettingsGit(pushBody, pushFoot, cols, barW, pushSticky) {
  if (S.mode === "sgmenu") {
    pushSticky("  " + BOLD + WHITE + "config-ledger" + RST);
    pushSticky("");
    for (var i = 0; i < SG_MENU_ITEMS.length; i++) {
      var sel = i === S.sgMenuCursor;
      var arrow = sel ? (ACCENT + " ❯ " + RST) : "   ";
      var bg = sel ? BG_SEL : "";
      var style = sel ? (BOLD + WHITE) : DIM;
      pushBody("  " + bg + arrow + style + SG_MENU_ITEMS[i].label + RST, sel);
    }
    pushFoot("  " + rule(barW));
    pushFoot(hints([["↑↓", "move"], ["enter", "select"], ["esc", "back"]]));
    return;
  }
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
        var label = trunc(r.file + " " + r.key, fileW);
        pushBody("  " + INFO + pad(label, fileW) + RST + "  " + GRAY + r.old + RST + DIM + " → " + RST + WHITE + r.new + RST, false);
      }
    }
    pushFoot("  " + rule(barW));
    pushFoot(hints([["c", "commit (live → repo)"], ["i", "import (repo → live)"], ["esc", "back"]]));
    return;
  }
  if (S.mode === "sghistory") {
    pushSticky("  " + BOLD + WHITE + "History" + RST + DIM + "  " + S.clHistoryFile + " " + S.clHistoryKey + RST);
    pushSticky("");
    const hist = S.clHistory || [];
    if (!hist.length) {
      pushBody("  " + GRAY + "No recorded history for this setting." + RST, false);
    } else {
      for (let i = 0; i < hist.length; i++) {
        const h = hist[i];
        const sel = i === S.clHistoryCursor;
        const arrow = sel ? (ACCENT + " ❯ " + RST) : "   ";
        const bg = sel ? BG_SEL : "";
        const val = (h.value === undefined || h.value === null) ? "(unset)" : JSON.stringify(h.value);
        pushBody("  " + bg + arrow + DIM + String(h.date) + RST + bg + "  " + GRAY + String(h.hash).slice(0, 7) + RST + bg + "  " + WHITE + trunc(val, Math.max(20, cols - 40)) + RST, sel);
      }
    }
    pushFoot("  " + rule(barW));
    pushFoot(hints([["↑↓", "move"], ["enter", "roll back to this value"], ["esc", "back"]]));
    return;
  }
  if (S.mode === "sgprofiles" || S.mode === "sgprofinput") {
    pushSticky("  " + BOLD + WHITE + "Profiles" + RST + DIM + "  branches of the config repo" + RST);
    pushSticky("");
    const profs = S.clProfiles || [];
    for (let i = 0; i < profs.length; i++) {
      const sel = i === S.clProfileCursor && S.mode === "sgprofiles";
      const arrow = sel ? (ACCENT + " ❯ " + RST) : "   ";
      const bg = sel ? BG_SEL : "";
      const cur = profs[i] === S.clProfileCurrent ? (OK + " (current)" + RST) : "";
      pushBody("  " + bg + arrow + (sel ? BOLD + WHITE : DIM) + profs[i] + RST + cur, sel);
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
    const m = S.CONFIG_LEDGER_MODULE;
    let ready = false, remote = "", gh = false;
    try { ready = m && m.repo.isRepo(); } catch {}
    try { remote = m && m.repo.hasRemote() ? m.repo.getRemote() : "(none)"; } catch { remote = "(none)"; }
    try { gh = m && m.setup.ghAvailable(); } catch {}
    pushSticky("  " + BOLD + WHITE + "Repo setup" + RST);
    pushSticky("  " + DIM + "status: " + RST + (ready ? OK + "initialized" + RST : GRAY + "not initialized" + RST) + DIM + "  remote: " + RST + WHITE + remote + RST);
    pushSticky("");
    const opts = [
      { key: "init", label: ready ? "Re-seed from current config" : "Initialize + seed repo" },
      { key: "remote", label: "Set remote URL..." },
    ];
    if (gh) opts.push({ key: "gh", label: "Create private GitHub repo (gh)" });
    S._sgSetupOpts = opts; // stash for the input handler
    for (let i = 0; i < opts.length; i++) {
      const sel = i === S.sgSetupCursor && S.mode === "sgsetup";
      const arrow = sel ? (ACCENT + " ❯ " + RST) : "   ";
      const bg = sel ? BG_SEL : "";
      pushBody("  " + bg + arrow + (sel ? BOLD + WHITE : DIM) + opts[i].label + RST, sel);
    }
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
