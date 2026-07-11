// @ts-nocheck
// Renderers for the config-git sub-screens reached from the Settings tab:
// the git action menu (sgmenu) and the setting-level diff review (sgdiff).
import { S } from "../state.js";
import { RST, BOLD, DIM, GRAY, WHITE, ACCENT, INFO, BG_SEL, pad, trunc, rule } from "../format.js";
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
    pushSticky("  " + BOLD + WHITE + "config-git" + RST);
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
    var rows = S.cgDiffRows || [];
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
    pushFoot(hints([["c", "commit"], ["esc", "back"]]));
    return;
  }
}
