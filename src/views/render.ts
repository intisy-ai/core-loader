// @ts-nocheck
// Top-level frame renderer: builds header + tabs, dispatches to the active
// page/overlay builder, applies viewport scrolling, and writes to stderr.

import { E, RST, BOLD, DIM, GRAY, WHITE, BG_SEL, CLR, ACCENT, rule } from "../format.js";
import { S } from "../state.js";
import { APP_NAME } from "../env.js";
import { buildConfirm, buildHelp, updateSpinner } from "./common.js";
import { buildProjects } from "./projects.js";
import { buildPlugins } from "./plugins.js";
import { buildMcp } from "./mcp.js";
import { buildSettings } from "./settings.js";

export function render() {
  // Prefer the stream we draw to (stderr), but fall back to stdout — depending on how
  // the wrapper launches bun, only one of them reports a TTY size. Re-read every frame
  // so the UI tracks live terminal resizes.
  var cols = process.stderr.columns || process.stdout.columns || 80;
  var totalRows = (process.stderr.rows || process.stdout.rows || 24) - 1;
  // rules/dividers span the full width so the frame scales with the console.
  var barW = Math.max(20, cols - 4);

  var headLines = [];
  var bodyLines = [];
  var footLines = [];
  var selStart = 0;
  var selEnd = 0;

  function pushHead(s) { headLines.push(s); }
  function pushBody(s, isSelLine) { 
    if (isSelLine && selStart === 0) selStart = bodyLines.length;
    bodyLines.push(s); 
    if (isSelLine) selEnd = bodyLines.length;
  }
  function pushFoot(s) { footLines.push(s); }

  // 1. Build Header
  pushHead("");
  pushHead("  " + BOLD + ACCENT + APP_NAME + RST + DIM + " · Loader" + RST);
  pushHead("  " + rule(barW));
  var showPluginsTab = S.pluginItems.length > 0 || S.MARKETPLACE_CATALOG.length > 0;
  var projTab = S.page === "projects" ? (BOLD + ACCENT + BG_SEL + " Projects " + RST) : (GRAY + " Projects " + RST);
  var plugTab = showPluginsTab ? (S.page === "plugins" ? (BOLD + ACCENT + BG_SEL + " Plugins " + RST) : (GRAY + " Plugins " + RST)) : "";
  var mcpTab = S.page === "mcp" ? (BOLD + ACCENT + BG_SEL + " MCP " + RST) : (GRAY + " MCP " + RST);
  var settingsTab = S.page === "settings" ? (BOLD + ACCENT + BG_SEL + " Settings " + RST) : (GRAY + " Settings " + RST);
  pushHead("  " + projTab + "  " + plugTab + "  " + mcpTab + "  " + settingsTab + "    " + DIM + "← →" + RST);
  pushHead("");

  if (S.helpOpen) {
    buildHelp(pushBody, pushFoot, cols, barW);
  } else if (S.mode === "confirm") {
    buildConfirm(pushBody, pushFoot, cols, barW);
  } else if (S.page === "projects") {
    buildProjects(pushBody, pushFoot, cols, barW);
  } else if (S.page === "mcp") {
    buildMcp(pushBody, pushFoot, cols, barW);
  } else if (S.page === "settings") {
    buildSettings(pushBody, pushFoot, cols, barW);
  } else {
    buildPlugins(pushBody, pushFoot, cols, barW);
  }
  updateSpinner();

  // exactly one blank line above the footer separator: drop any trailing blanks a
  // view appended, then add the single spacer (so menus never show a double gap)
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "") bodyLines.pop();
  if (footLines.length) footLines.unshift("");

  // 3. Viewport calculation
  var maxBody = Math.max(2, totalRows - headLines.length - footLines.length);
  
  var activeScroll = 0;
  if (S.page === "projects") activeScroll = S.scrollOff;
  else if (S.page === "mcp") activeScroll = S.mcpScrollOff;
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

    if (S.page === "projects") S.scrollOff = activeScroll;
    else if (S.page === "mcp") S.mcpScrollOff = activeScroll;
    else if (S.page === "settings") S.settingsScrollOff = activeScroll;
    else if (S.mode === "pcommits") S.cscrollOff = activeScroll;
    else if (S.page === "plugins" && S.pluginSubPage === "marketplace") S.mkScrollOff = activeScroll;
    else S.pscrollOff = activeScroll;

    var hiddenAbove = activeScroll;
    var hiddenBelow = bodyLines.length - (activeScroll + innerH);
    // at scroll-top the reserved top marker is blank; drop the header's trailing
    // blank so it doesn't stack into a double gap above the tabs
    if (hiddenAbove === 0 && headLines.length && headLines[headLines.length - 1] === "") headLines.pop();
    var visibleBody = bodyLines.slice(activeScroll, activeScroll + innerH);
    visibleBody.unshift(hiddenAbove > 0 ? "  " + GRAY + "     ↑ " + hiddenAbove + " more" + RST : "");
    visibleBody.push(hiddenBelow > 0 ? "  " + GRAY + "     ↓ " + hiddenBelow + " more" + RST : "");
    bodyLines = visibleBody;
  } else {
    // content fits — pad with blank rows so the footer always sits at the bottom
    while (bodyLines.length < maxBody) bodyLines.push("");
  }

  // no newline after the last row: writing into the bottom-right corner would
  // scroll the terminal and shift the whole frame every redraw
  S._buf = "\x1b[?2026h" + E + "H";
  S._buf += headLines.concat(bodyLines, footLines).map(function(l) { return l + CLR; }).join("\n");
  S._buf += E + "J" + "\x1b[?2026l";

  process.stderr.write(S._buf);
  S._buf = "";
}

