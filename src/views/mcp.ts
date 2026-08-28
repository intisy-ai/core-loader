// MCP page rendering: installed / marketplace sub-pages and the action menu.

import { RST, BOLD, DIM, GRAY, WHITE, YELLOW, GREEN, BG_SEL, stringWidth, pad, trunc, ACCENT, rule } from "../format.js";
import { S } from "../state.js";
import { buildMcpList, getMcpActions, buildInstalledMcpRows } from "../mcp.js";
import { hints, messageLine, marketplaceRow } from "./common.js";
import type { PushBody, PushFoot, PushSticky } from "./common.js";

/** Draws the MCP page. */
export function buildMcp(pushBody: PushBody, pushFoot: PushFoot, cols: number, barW: number, pushSticky: PushSticky): void {
  var nameW = Math.min(28, Math.max(18, cols - 50));

  if (S.mcpMode === "actions") {
    var mitem = S.mcpSubPage === "installed" ? buildInstalledMcpRows()[S.mcpCursor] : S.mcpItems[S.mcpCursor];
    if (!mitem) { S.mcpMode = "catalog"; return; }
    var acts = getMcpActions(mitem);
    pushBody("  " + BOLD + WHITE + "" + mitem.name + RST, false);
    pushBody("  " + GRAY + (mitem.desc || mitem.command + " " + (mitem.args || []).join(" ")) + RST, false);
    var envKeys = Object.keys(mitem.env || {});
    if (envKeys.length > 0) {
      pushBody("  " + GRAY + "Env: " + envKeys.join(", ") + RST, false);
    }
    pushBody("", false);
    for (var j = 0; j < acts.length; j++) {
      var a = acts[j];
      var aSel = j === S.mcpAcursor;
      if (aSel) {
        pushBody("    " + ACCENT + "❯ " + BOLD + ACCENT + a.label + RST, true);
      } else {
        pushBody("    " + DIM + "  " + a.label + RST, false);
      }
    }
    pushBody("", false);
    pushFoot("  " + rule(barW));
    pushFoot(hints([["↑↓", "move"], ["enter", "confirm"], ["esc", "back"]]));
    return;
  }

  var mcpInstTab = S.mcpSubPage === "installed" ? (BOLD + ACCENT + BG_SEL + " Installed " + RST) : (GRAY + " Installed " + RST);
  var mcpMktTab = S.mcpSubPage === "marketplace" ? (BOLD + ACCENT + BG_SEL + " Marketplace " + RST) : (GRAY + " Marketplace " + RST);
  pushSticky("  " + mcpInstTab + "  " + mcpMktTab + "    " + DIM + "tab switch" + RST);
  pushSticky("");

  if (S.mcpSubPage === "installed") {
    var installedList = buildInstalledMcpRows();
    var realCount = installedList.filter(function(r) { return !r.isAction; }).length;
    if (realCount === 0) {
      pushBody("  " + GRAY + "No MCP servers installed." + RST, false);
      pushBody("  " + GRAY + "Switch to Marketplace to browse and install servers." + RST, false);
    } else {
      pushSticky("  " + BOLD + WHITE + "Installed MCP Servers" + RST + GRAY + " (" + realCount + ")" + RST);
    }
    var mcpPrevAction = false;
    for (var i = 0; i < installedList.length; i++) {
      var m = installedList[i];
      var sel = i === S.mcpCursor;
      var arrow = sel ? (ACCENT + " \u276f " + RST) : "   ";
      var bg = sel ? BG_SEL : "";
      if (m.isAction) {
        pushBody("  " + bg + arrow + (sel ? (BOLD + ACCENT) : DIM) + m.name + RST, sel);
        mcpPrevAction = true;
        continue;
      }
      if (mcpPrevAction) {
        pushBody("", false);   // gap between the leading action rows and real content
        mcpPrevAction = false;
      }
      var nameStyle = sel ? (BOLD + WHITE) : DIM;
      if (m.fromCapability) {
        pushBody("  " + bg + arrow + DIM + "\u25cf" + RST + " " + nameStyle + pad(trunc(m.name, nameW), nameW) + RST + bg + "  " + GRAY + (m.transport || "") + (m.detail ? "  " + m.detail : "") + RST, sel);
      } else {
        pushBody("  " + bg + arrow + DIM + "\u25cf" + RST + " " + nameStyle + pad(trunc(m.name, nameW), nameW) + RST + bg + "  " + GRAY + m.command + " " + (m.args || []).join(" ") + RST, sel);
        if (sel) {
          var ek = Object.keys(m.env || {});
          if (ek.length > 0) pushBody("  " + GRAY + "     env: " + ek.join(", ") + RST, sel);
        }
      }
    }
    pushBody("", false);
    if (S.mode === "mcpaddinput") {
      var draft = S.mcpAddDraft || { name: "", transport: "http", target: "" };
      pushFoot("  " + rule(barW));
      if (S.mcpAddStep === 1) {
        var httpSel = draft.transport === "http";
        pushFoot("  " + ACCENT + "Transport: " + RST
          + (httpSel ? (BOLD + ACCENT + "[http]" + RST) : (DIM + " http " + RST)) + "  "
          + (!httpSel ? (BOLD + ACCENT + "[stdio]" + RST) : (DIM + " stdio " + RST)));
        pushFoot(hints([["\u2190\u2192", "toggle"], ["enter", "next"], ["esc", "cancel"]]));
      } else {
        var stepLabel = S.mcpAddStep === 0 ? "Name: " : ("Target (" + (draft.transport === "http" ? "URL" : "command") + "): ");
        pushFoot("  " + ACCENT + stepLabel + RST + S.inputBuf + BOLD + "|" + RST);
        pushFoot(hints([["enter", S.mcpAddStep === 2 ? "confirm" : "next"], ["esc", "cancel"]]));
      }
      return;
    }
    if (S.message) {
      pushFoot(messageLine(cols));
    }
    pushFoot("  " + rule(barW));
    pushFoot(hints([["\u2191\u2193", "move"], ["enter", "select"], ["tab", "switch"], ["?", "help"], ["q", "quit"]]));
  } else {
    // Marketplace
    S.mcpItems = buildMcpList("All");
    pushSticky("  " + BOLD + WHITE + "MCP Marketplace" + RST + GRAY + " (" + S.mcpItems.length + " available)" + RST + (S.mode === "search" || S.inputBuf ? " " + BG_SEL + " Search: " + S.inputBuf + (S.mode === "search" ? "_" : "") + " " + RST : " " + DIM + "(press / to search)" + RST) + "  " + ACCENT + "✦" + RST + DIM + " = curated" + RST);
    for (var i = 0; i < S.mcpItems.length; i++) {
      var m = S.mcpItems[i];
      var sel = i === S.mcpCursor;
      var statusIcon = m.installed ? (DIM + "\u25cf" + RST) : (GRAY + "\u25cb" + RST);
      // ✦ marks hand-picked entries; non-curated get 2 spaces to keep columns aligned
      var curatedMark = m.curated ? (ACCENT + "✦ " + RST) : "  ";
      pushBody(marketplaceRow(cols, { selected: sel, name: m.name, nameW: nameW, desc: m.desc, stars: m.stars, statusIcon: statusIcon, badge: curatedMark, badgeW: 2 }), sel);
      if (sel) {
        pushBody("  " + GRAY + "     " + m.command + " " + (m.args || []).join(" ") + RST, sel);
        var ek = Object.keys(m.env || {});
        if (ek.length > 0) pushBody("  " + GRAY + "     env: " + ek.join(", ") + RST, sel);
      }
    }
    pushBody("", false);
    if (S.message) {
      pushFoot(messageLine(cols));
    }
    pushFoot("  " + rule(barW));
    pushFoot(hints([["↑↓", "move"], ["enter", "select"], ["/", "search"], ["?", "help"], ["q", "quit"]]));
  }
}

