// Top-level frame renderer: builds header + tabs, dispatches to the active
// page/overlay builder, applies viewport scrolling, and writes to stderr.

import { E, RST, BOLD, DIM, GRAY, WHITE, BG_SEL, CLR, ACCENT, rule } from "../format.js";
import { S } from "../state.js";
import { APP_NAME } from "../env.js";
import { buildConfirm, buildHelp, updateSpinner } from "./common.js";
import { buildProjects } from "./projects.js";
import { buildPlugins } from "./plugins.js";
import { buildMcp } from "./mcp.js";
import { buildActivity } from "./activity.js";
import { buildSettings } from "./settings.js";

/** Draws one whole frame and writes it to stderr. */
export function render() {
  // Prefer the stream we draw to (stderr), but fall back to stdout, depending on how
  // the wrapper launches bun, only one of them reports a TTY size. Re-read every frame
  // so the UI tracks live terminal resizes.
  var cols = process.stderr.columns || process.stdout.columns || 80;
  var totalRows = (process.stderr.rows || process.stdout.rows || 24) - 1;
  // rules/dividers span the full width so the frame scales with the console.
  var barW = Math.max(20, cols - 4);

  var headLines: string[] = [];
  var stickyLines: string[] = [];
  var bodyLines: string[] = [];
  var footLines: string[] = [];
  var selStart = 0;
  var selEnd = 0;

  function pushHead(s: string) { headLines.push(s); }
  // Sticky region: rendered ALWAYS between the header/tabs and the scrollable body.
  // Never scrolled and never counted in selStart/selEnd, so a view's top info block
  // stays visible while only its list scrolls.
  function pushSticky(s: string) { stickyLines.push(s); }
  function pushBody(s: string, isSelLine?: boolean) {
    if (isSelLine && selStart === 0) selStart = bodyLines.length;
    bodyLines.push(s);
    if (isSelLine) selEnd = bodyLines.length;
  }
  function pushFoot(s: string) { footLines.push(s); }

  // 1. Build Header
  pushHead("");
  pushHead("  " + BOLD + ACCENT + APP_NAME + RST + DIM + " · Loader" + RST);
  pushHead("  " + rule(barW));
  var showPluginsTab = S.pluginItems.length > 0 || S.MARKETPLACE_CATALOG.length > 0;
  // Activity is a capability-gated tab: shown only once the host loader has
  // injected S.capabilities.activity (registered by tuiApi.registerCapabilities).
  var showActivityTab = !!(S.capabilities && S.capabilities.activity);
  var projTab = S.page === "projects" ? (BOLD + ACCENT + BG_SEL + " Projects " + RST) : (GRAY + " Projects " + RST);
  var plugTab = showPluginsTab ? (S.page === "plugins" ? (BOLD + ACCENT + BG_SEL + " Plugins " + RST) : (GRAY + " Plugins " + RST)) : "";
  var mcpTab = S.page === "mcp" ? (BOLD + ACCENT + BG_SEL + " MCP " + RST) : (GRAY + " MCP " + RST);
  var activityTab = showActivityTab ? (S.page === "activity" ? (BOLD + ACCENT + BG_SEL + " Activity " + RST) : (GRAY + " Activity " + RST)) : "";
  var settingsTab = S.page === "settings" ? (BOLD + ACCENT + BG_SEL + " Settings " + RST) : (GRAY + " Settings " + RST);
  pushHead("  " + projTab + "  " + plugTab + "  " + mcpTab + "  " + activityTab + "  " + settingsTab + "    " + DIM + "← →" + RST);
  pushHead("");

  if (S.helpOpen) {
    buildHelp(pushBody, pushFoot, cols, barW);
  } else if (S.mode === "confirm") {
    buildConfirm(pushBody, pushFoot, cols, barW);
  } else if (S.page === "projects") {
    buildProjects(pushBody, pushFoot, cols, barW);
  } else if (S.page === "mcp") {
    buildMcp(pushBody, pushFoot, cols, barW, pushSticky);
  } else if (S.page === "activity" && showActivityTab) {
    buildActivity(pushBody, pushFoot, cols, barW, pushSticky);
  } else if (S.page === "settings") {
    buildSettings(pushBody, pushFoot, cols, barW, pushSticky);
  } else {
    buildPlugins(pushBody, pushFoot, cols, barW, pushSticky);
  }
  updateSpinner();

  // exactly one blank line above the footer separator: drop any trailing blanks a
  // view appended, then add the single spacer (so menus never show a double gap)
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "") bodyLines.pop();
  if (footLines.length) footLines.unshift("");

  // 3. Viewport calculation: the scrollable body occupies the space BELOW the
  // header/tabs and the sticky region (which are always shown in full).
  var maxBody = Math.max(2, totalRows - headLines.length - stickyLines.length - footLines.length);
  
  // A contributed screen sub-page scrolls on its own offset; the Settings sub-page keeps
  // settingsScrollOff.
  var onScreenSubPage = S.page === "settings" && S.settingsSubPage && S.settingsSubPage !== "settings";

  var activeScroll = 0;
  if (S.page === "projects") activeScroll = S.scrollOff;
  else if (S.page === "mcp") activeScroll = S.mcpScrollOff;
  else if (S.page === "activity") activeScroll = S.activityScrollOff;
  else if (onScreenSubPage) activeScroll = S.screenScrollOff;
  else if (S.page === "settings") activeScroll = S.settingsScrollOff;
  else if (S.mode === "pcommits") activeScroll = S.cscrollOff;
  else if (S.page === "plugins" && S.pluginSubPage === "marketplace") activeScroll = S.mkScrollOff;
  else activeScroll = S.pscrollOff;

  if (bodyLines.length > maxBody) {
    // marker rows are always reserved so the geometry never shifts between frames
    var innerH = maxBody - 2;
    var contextLines = 3;
    if (selStart - activeScroll < contextLines) activeScroll = Math.max(0, selStart - contextLines);
    if (selEnd - activeScroll > innerH) activeScroll = selEnd - innerH;
    if (activeScroll > bodyLines.length - innerH) activeScroll = bodyLines.length - innerH;
    if (activeScroll < 0) activeScroll = 0;
    // Snap to the very top when we're within a few lines of it: otherwise the non-
    // selectable header block (counts/paths/etc. above the first selectable row) stays
    // scrolled off behind a spurious "↑ N more" after scrolling down and back up. Safe
    // because a tiny activeScroll means the selection is near the top and still fits.
    if (activeScroll <= contextLines) activeScroll = 0;

    if (S.page === "projects") S.scrollOff = activeScroll;
    else if (S.page === "mcp") S.mcpScrollOff = activeScroll;
    else if (S.page === "activity") S.activityScrollOff = activeScroll;
    else if (onScreenSubPage) S.screenScrollOff = activeScroll;
    else if (S.page === "settings") S.settingsScrollOff = activeScroll;
    else if (S.mode === "pcommits") S.cscrollOff = activeScroll;
    else if (S.page === "plugins" && S.pluginSubPage === "marketplace") S.mkScrollOff = activeScroll;
    else S.pscrollOff = activeScroll;

    var hiddenAbove = activeScroll;
    var hiddenBelow = bodyLines.length - (activeScroll + innerH);
    // at scroll-top the reserved top marker is blank; drop the trailing blank of
    // whatever sits directly above the body (the sticky block if present, else the
    // header) so it doesn't stack into a double gap above the first row
    if (hiddenAbove === 0) {
      if (stickyLines.length && stickyLines[stickyLines.length - 1] === "") stickyLines.pop();
      else if (!stickyLines.length && headLines.length && headLines[headLines.length - 1] === "") headLines.pop();
    }
    var visibleBody = bodyLines.slice(activeScroll, activeScroll + innerH);
    visibleBody.unshift(hiddenAbove > 0 ? "  " + GRAY + "     ↑ " + hiddenAbove + " more" + RST : "");
    visibleBody.push(hiddenBelow > 0 ? "  " + GRAY + "     ↓ " + hiddenBelow + " more" + RST : "");
    bodyLines = visibleBody;
  } else {
    // content fits, pad with blank rows so the footer always sits at the bottom
    while (bodyLines.length < maxBody) bodyLines.push("");
  }

  // no newline after the last row: writing into the bottom-right corner would
  // scroll the terminal and shift the whole frame every redraw
  S._buf = "\x1b[?2026h" + E + "H";
  S._buf += headLines.concat(stickyLines, bodyLines, footLines).map(function(l) { return l + CLR; }).join("\n");
  S._buf += E + "J" + "\x1b[?2026l";

  process.stderr.write(S._buf);
  S._buf = "";
}

