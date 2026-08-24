// @ts-nocheck
// Shared view helpers: status message, spinner, hint bar, and the confirm/help
// overlays. flash/scheduleRender drive redraws via render().

import { RST, BOLD, DIM, GRAY, WHITE, GREEN, YELLOW, BG_SEL, stringWidth, trunc, pad, ACCENT, rule } from "../format.js";
import { S } from "../state.js";
import { HELP_BINDINGS, SPINNER_FRAMES } from "../env.js";
import { render } from "./render.js";

// One marketplace row, shared by the plugins AND MCP marketplaces, they differ only
// in the badge (curated ✦ vs git/npm) and the selected sub-line, never the layout.
// The star count is right-aligned to the edge and the description scales with `cols`.
// opts: { selected, name, nameW, desc, stars, statusIcon (colored 1-char), badge, badgeW }
export function marketplaceRow(cols, opts) {
  var sel = opts.selected;
  var arrow = sel ? (ACCENT + " ❯ " + RST) : "   ";
  var bg = sel ? BG_SEL : "";
  var nameStyle = sel ? (BOLD + WHITE) : DIM;
  var nameW = opts.nameW;
  var badge = opts.badge || "";
  var badgeW = opts.badgeW || 0;
  var starRaw = opts.stars != null ? " ★" + opts.stars : "";
  var starVis = starRaw.length;
  var usedW = 2 + 3 + 1 + 1 + badgeW + nameW + 2 + starVis;
  var descW = Math.max(10, cols - usedW - 2);
  var descText = trunc(String(opts.desc || "").replace(/\r?\n/g, " "), descW);
  var descVis = stringWidth(descText);
  var gapW = Math.max(1, cols - usedW - descVis);
  var starStr = starRaw ? (YELLOW + " ".repeat(gapW) + "★" + opts.stars + RST) : "";
  return "  " + bg + arrow + opts.statusIcon + " " + badge + nameStyle + pad(trunc(opts.name, nameW), nameW) + RST + bg + "  " + GRAY + descText + RST + starStr + RST;
}

export function flash(msg) {
  S.message = msg;
  if (S.msgTimeout) clearTimeout(S.msgTimeout);
  S.msgTimeout = setTimeout(function() { S.message = ""; render(); }, 2500);
}

// async catalog fetches arrive in bursts, coalesce their redraws
export function scheduleRender() {
  if (S.renderTimer) return;
  S.renderTimer = setTimeout(function() { S.renderTimer = null; render(); }, 120);
}

export function hints(pairs) {
  return "  " + GRAY + pairs.map(function(p) { return p[0] + " " + p[1]; }).join(" · ") + RST;
}

export function spinnerFrame() { return ACCENT + SPINNER_FRAMES[S.spinnerTick % SPINNER_FRAMES.length] + RST; }

export function updateSpinner() {
  var active = S.catalogPending > 0 || (S.message && S.message.indexOf("...") !== -1);
  if (active && !S.spinnerTimer) {
    S.spinnerTimer = setInterval(function() { S.spinnerTick++; render(); }, 120);
  } else if (!active && S.spinnerTimer) {
    clearInterval(S.spinnerTimer);
    S.spinnerTimer = null;
  }
}

export function messageLine(cols) {
  var prefix = S.message.indexOf("...") !== -1 ? spinnerFrame() + " " : "  ";
  return "  " + ACCENT + prefix + trunc(S.message, cols - 6) + RST;
}

export function buildConfirm(pushBody, pushFoot, cols, barW) {
  pushBody("  " + BOLD + WHITE + "Confirm" + RST, false);
  pushBody("", false);
  pushBody("  " + BOLD + WHITE + trunc(S.confirmLabel, cols - 4) + RST, false);
  pushBody("", false);
  var opts = ["Yes", "Cancel"];
  for (var i = 0; i < opts.length; i++) {
    if (i === S.confirmCursor) {
      pushBody("    " + ACCENT + "❯ " + BOLD + ACCENT + opts[i] + RST, true);
    } else {
      pushBody("    " + DIM + "  " + opts[i] + RST, false);
    }
  }
  pushBody("", false);
  pushFoot("  " + rule(barW));
  pushFoot(hints([["↑↓", "move"], ["enter", "confirm"], ["y", "yes"], ["n/esc", "cancel"]]));
}

export function buildHelp(pushBody, pushFoot, cols, barW) {
  var binds = HELP_BINDINGS[S.page] || [];
  pushBody("  " + BOLD + WHITE + "Keyboard shortcuts" + RST, false);
  pushBody("", false);
  for (var i = 0; i < binds.length; i++) {
    pushBody("    " + BOLD + WHITE + pad(binds[i][0], 16) + RST + GRAY + binds[i][1] + RST, false);
  }
  pushBody("", false);
  pushFoot("  " + rule(barW));
  pushFoot(hints([["any key", "close"]]));
}
