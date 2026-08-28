// Projects page rendering: each project row, the "open here" row, and the
// full projects view with its action menu and footer.

import { RST, BOLD, DIM, GRAY, WHITE, BG_SEL, pad, trunc, timeAgo, ACCENT, rule } from "../format.js";
import { S } from "../state.js";
import { APP_NAME } from "../env.js";
import { getActions, shortPath } from "../projects.js";
import { hints, messageLine } from "./common.js";
import type { PushBody, PushFoot, PushSticky } from "./common.js";
import type { ProjectItem } from "../projects.js";

/** Draws one project row. */
export function buildProjectItem(pushBody: PushBody, i: number, item: ProjectItem, nameW: number, cols: number, isSelected?: boolean): void {
  var sel = i === S.cursor;
  var arrow = sel ? (ACCENT + " ❯ " + RST) : "   ";
  var bg = sel ? BG_SEL : "";
  var nameStyle = sel ? (BOLD + WHITE) : DIM;
  var sessStr = GRAY + pad(item.sessions + " sess", 8) + RST;
  var timeStr = GRAY + pad(timeAgo(item.lastUsed), 9) + RST;
  var pinMark = item.pinned ? (ACCENT + " *" + RST) : "";

  pushBody("  " + bg + arrow + nameStyle + pad(trunc(item.name, nameW), nameW) + RST + bg + sessStr + timeStr + pinMark + RST, isSelected);

  if (sel && (S.mode === "list" || S.mode === "actions")) {
    pushBody("  " + GRAY + "     " + trunc(shortPath(item.dir), cols - 10) + RST, isSelected);
  }

  if (sel && S.mode === "actions") {
    pushBody("", isSelected);
    var acts = getActions(item);
    for (var j = 0; j < acts.length; j++) {
      var a = acts[j];
      var aSel = j === S.acursor;
      var lbl = trunc(a.label, cols - 12);
      if (aSel) {
        pushBody("    " + ACCENT + "❯ " + BOLD + ACCENT + lbl + RST, isSelected);
      } else {
        pushBody("    " + DIM + "  " + lbl + RST, isSelected);
      }
    }
    pushBody("", isSelected);
  }
}

/** Draws the row that opens the current working directory. */
export function buildOpenHereItem(pushBody: PushBody): void {
  var sel = S.cursor === S.items.length;
  var arrow = sel ? (ACCENT + " ❯ " + RST) : "   ";
  var bg = sel ? BG_SEL : "";
  var nameStyle = sel ? (BOLD + WHITE) : DIM;
  pushBody("  " + bg + arrow + nameStyle + "Open " + APP_NAME + " here" + RST + bg + "  " + GRAY + process.cwd() + RST, sel);
}

/** Draws the session picker for the project being opened. */
export function buildSessions(pushBody: PushBody, pushFoot: PushFoot, cols: number, barW: number): void {
  var nameW = Math.min(46, Math.max(20, cols - 18));
  var proj = (S.sessionDir || "").split(/[\\/]/).pop() || S.sessionDir;
  pushBody("  " + BOLD + WHITE + "Sessions" + RST + GRAY + " · " + trunc(proj, cols - 16) + RST, false);
  pushBody("", false);

  // Row 0: start a new session.
  var selNew = S.scursor === 0;
  var newArrow = selNew ? (ACCENT + " ❯ " + RST) : "   ";
  var newBg = selNew ? BG_SEL : "";
  var newStyle = selNew ? (BOLD + WHITE) : DIM;
  pushBody("  " + newBg + newArrow + newStyle + "＋ New session" + RST, selNew);

  for (var i = 0; i < S.sessionItems.length; i++) {
    var it = S.sessionItems[i];
    var sel = S.scursor === i + 1;
    var arrow = sel ? (ACCENT + " ❯ " + RST) : "   ";
    var bg = sel ? BG_SEL : "";
    var nameStyle = sel ? (BOLD + WHITE) : DIM;
    var timeStr = GRAY + pad(timeAgo(it.lastUsed), 9) + RST;
    pushBody("  " + bg + arrow + nameStyle + pad(trunc(it.title, nameW), nameW) + RST + bg + timeStr + RST, sel);
  }

  pushBody("", false);
  pushFoot("  " + rule(barW));
  pushFoot(hints([["↑↓", "move"], ["enter", "select"], ["esc", "back"]]));
}

/** Draws the Projects page, or the session picker when one is open. */
export function buildProjects(pushBody: PushBody, pushFoot: PushFoot, cols: number, barW: number): void {
  if (S.mode === "sessions") { buildSessions(pushBody, pushFoot, cols, barW); return; }
  var nameW = Math.min(28, Math.max(16, cols - 36));

  if (S.items.length === 0) {
    pushBody("  " + GRAY + "No projects found." + RST, false);
    pushBody("  " + GRAY + "Use " + APP_NAME + " in a directory first, then come back." + RST, false);
    pushBody("", false);
    buildOpenHereItem(pushBody);
    pushBody("", false);

    pushFoot("  " + rule(barW));
    pushFoot(hints([["enter", "select"], ["u", "unhide all"], ["q", "quit"]]));
    return;
  }

  var pinnedCount = 0;
  for (var i = 0; i < S.items.length; i++) { if (S.items[i].pinned) pinnedCount++; }
  var recentCount = S.items.length - pinnedCount;

  if (pinnedCount > 0) {
    pushBody("  " + BOLD + WHITE + "Pinned" + RST, false);
    for (var i = 0; i < pinnedCount; i++) {
      buildProjectItem(pushBody, i, S.items[i], nameW, cols, i === S.cursor);
    }
  }

  if (pinnedCount > 0 && recentCount > 0) pushBody("", false);

  if (recentCount > 0) {
    var countLabel = recentCount > 0 ? " (" + recentCount + ")" : "";
    pushBody("  " + BOLD + WHITE + "Recent" + RST + GRAY + countLabel + RST, false);
    for (var i = pinnedCount; i < S.items.length; i++) {
      buildProjectItem(pushBody, i, S.items[i], nameW, cols, i === S.cursor);
    }
  }

  pushBody("", false);
  buildOpenHereItem(pushBody);
  pushBody("", false);

  if (S.message) {
    pushFoot(messageLine(cols));
  }
  pushFoot("  " + rule(barW));

  if (S.mode === "input") {
    var inputLabel = S.chpathDir ? "New path: " : "Path: ";
    var maxInput = Math.max(10, cols - 15 - inputLabel.length);
    var displayInput = S.inputBuf.length > maxInput ? "…" + S.inputBuf.substring(S.inputBuf.length - maxInput + 1) : S.inputBuf;
    pushFoot("  " + ACCENT + inputLabel + RST + displayInput + BOLD + "|" + RST);
    pushFoot(hints([["enter", "confirm"], ["esc", "cancel"]]));
  } else if (S.mode === "list") {
    pushFoot(hints([["↑↓", "move"], ["enter", "select"], ["o", "open"], ["?", "help"], ["q", "quit"]]));
  } else {
    pushFoot(hints([["↑↓", "move"], ["enter", "confirm"], ["esc", "back"]]));
  }
}

