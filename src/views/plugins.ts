// Plugins page rendering: plugin rows (git + npm + engine), the installed /
// marketplace / custom sub-pages, and the action/commit menus.

import { RST, BOLD, DIM, GRAY, WHITE, YELLOW, GREEN, CYAN, RED, MAGENTA, BG_SEL, stringWidth, pad, trunc, timeAgo, ACCENT, OK, BAD, INFO, rule, secretMask, entryMask, isBooleanRowOn } from "../format.js";
import { selectionKey } from "../selection.js";
import { S } from "../state.js";
import { loadPlugins } from "../config.js";
import { loadNpmPlugins, getUpdater, getUpdaterVersion, getUpdaterPath, managerBootstrapCommand, resolvedManager } from "../updater.js";
import { getPluginActions, hostPluginId, readUpdateCache } from "../plugins.js";
import { getMarketplaceActions } from "../marketplace.js";
import { HOME, CONFIG_DIR, PLUGINS_DIR, REPOS_DIR, APP_NAME } from "../env.js";
import { appNpmPlugins, expandPath } from "../app-descriptor.js";
import { hints, messageLine, spinnerFrame, marketplaceRow } from "./common.js";
import { diagnosticLines } from "../plugin-diagnostics.js";
import { ledgerRowFor } from "../plugin-surface.js";
import type { PushBody, PushFoot, PushSticky } from "./common.js";
import type { PluginRow } from "../plugins.js";
import type { SettingsRow } from "../settings-model.js";

// Normalizes any rendered version/tag to a single "vX.Y.Z" form: strips a
// leading v/V (if present) then re-adds exactly one "v", so a git tag, an npm
// registry version, and a foreign-plugin version all display consistently.
// A trailing git "(shortsha)" suffix (added by buildPluginList) is preserved.
function vlabel(v: string | undefined): string | undefined {
  if (!v) return v;
  var s = String(v);
  var suffixMatch = s.match(/(\s\([0-9a-fA-F]{4,40}\))$/);
  var suffix = suffixMatch ? suffixMatch[1] : "";
  var base = suffix ? s.slice(0, s.length - suffix.length) : s;
  base = base.replace(/^[vV]/, "");
  return "v" + base + suffix;
}

/** Draws one plugin row. */
export function buildPluginItem(pushBody: PushBody, i: number, pitem: PluginRow, nameW: number, cols: number, isSelected?: boolean): void {
  var sel = i === S.pcursor;
  var arrow = sel ? (ACCENT + " ❯ " + RST) : "   ";
  var bg = sel ? BG_SEL : "";
  var nameStyle = sel ? (BOLD + WHITE) : DIM;

  // App-managed plugins (native to the host app's own plugin system): selectable
  // like everything else in the list, actions gated by whichever capabilities
  // getPluginActions() finds registered.
  if (pitem.type === "foreign") {
    var fstate = pitem.enabled === false ? (BAD + "disabled" + RST) : (OK + "enabled" + RST);
    var fver = pitem.version ? (GRAY + vlabel(pitem.version) + RST) : (GRAY + "---" + RST);
    pushBody("  " + bg + arrow + nameStyle + pad(trunc(pitem.name, nameW), nameW) + RST + bg + " " + fstate + "  " + fver + RST, isSelected);
    if (sel) {
      var fsubInfo = GRAY + "     " + (pitem.source ? "marketplace: " + pitem.source : "app-managed plugin") + RST;
      pushBody("  " + fsubInfo, isSelected);
    }
    return;
  }

  // NPM plugins: simpler read-only row
  if (pitem.type === "npm") {
    var nvstr = pitem.engine
      ? (pitem.version ? (GRAY + vlabel(pitem.version) + RST + " " + OK + "active" + RST) : (OK + "active" + RST))
      : pitem.version ? (GRAY + vlabel(pitem.version) + RST) : (GRAY + "not installed" + RST);
    var typeLabel = pitem.engine ? (DIM + "engine" + RST) : (GRAY + "npm" + RST);
    pushBody("  " + bg + arrow + nameStyle + pad(trunc(pitem.name, nameW), nameW) + RST + bg + " " + typeLabel + "  " + nvstr + RST, isSelected);
    if (sel) {
      var subInfo = GRAY + "     " + (pitem.engine ? "manages plugin installs and updates" : "managed by the app's own plugin list") + RST;
      pushBody("  " + subInfo, isSelected);
    }
    return;
  }

  var statusParts = [];
  if (!pitem.enabled) {
    statusParts.push(BAD + "disabled" + RST);
  } else if (pitem.autoUpdate) {
    statusParts.push(OK + "auto" + RST);
  } else {
    statusParts.push(DIM + "manual" + RST);
  }
  if (pitem.enabled) {
    if (pitem.updateAvail) {
      statusParts.push(ACCENT + "UPDATE" + RST);
    } else if (pitem.deployed) {
      statusParts.push(GRAY + "ok" + RST);
    } else {
      statusParts.push(BAD + "missing" + RST);
    }
  }
  if (pitem.onExperimental) {
    statusParts.push(ACCENT + "experimental" + RST);
  }

  var statusStr = statusParts.join(GRAY + " | " + RST);
  var versionStr = pitem.latestTag
    ? (GRAY + vlabel(pitem.latestTag) + RST)
    : (pitem.localHead ? (DIM + pitem.localHead.substring(0, 7) + RST) : (GRAY + "---" + RST));

  pushBody("  " + bg + arrow + nameStyle + pad(trunc(pitem.name, nameW), nameW) + RST + bg + " " + statusStr + "  " + versionStr + RST, isSelected);

  if (sel) {
    var subInfo = GRAY + "     " + trunc(pitem.subject || pitem.url, cols - 10) + RST;
    pushBody("  " + subInfo, isSelected);
  }

}

/** Draws the Plugins page, across all its sub-tabs. */
export function buildPlugins(pushBody: PushBody, pushFoot: PushFoot, cols: number, barW: number, pushSticky: PushSticky): void {
  var nameW = Math.min(32, Math.max(20, cols - 44));

  // "hasUpdater" must mean the manager is actually INSTALLED AND LOADABLE, not merely listed:
  // basing it on the listing made the tab look usable when the manager was listed-but-absent, and
  // every action then silently no-op'd. getUpdater() answers with the imported module, so it is the
  // true functional test. Cache it: recompute only while not yet loaded, since it cannot vanish
  // mid-session.
  if (S.hasUpdater !== true) {
    var upd = getUpdater();
    S.hasUpdater = !!(upd && typeof upd.updatePluginPublic === "function");
  }
  var hasUpdater = S.hasUpdater;

  // Every plugin is installed and updated by whichever plugin declares plugin-management. With none
  // loadable there is nothing to manage, so both the Installed and Marketplace surfaces gate to one
  // instruction. The command is shown for the operator to run: npx always fetches the published
  // package, so this library never runs it.
  if (!hasUpdater && (S.pluginSubPage === "installed" || S.pluginSubPage === "marketplace")) {
    var bootstrap = managerBootstrapCommand();
    pushBody("  " + BOLD + BAD + "No plugin manager installed" + RST, false);
    pushBody("  Plugins are installed and updated by the plugin that declares plugin-management.", false);
    pushBody("  None is loadable in this home.", false);
    pushBody("", false);
    if (bootstrap) {
      pushBody("  " + GRAY + "Install it yourself, then press " + WHITE + "Enter" + GRAY + " to re-check:" + RST, false);
      pushBody("    " + WHITE + bootstrap + RST, false);
    } else {
      pushBody("  " + GRAY + "No repository in the declared marketplaces declares that capability." + RST, false);
      pushBody("  " + GRAY + "Add a source that offers one to config/marketplaces.json." + RST, false);
    }
    pushBody("", false);
    pushFoot("  " + rule(barW));
    pushFoot(hints([["enter", "re-check"], ["q", "quit"]]));
    S.globalKeyHandler = "manager_recheck";
    return;
  }
  if (S.globalKeyHandler === "manager_recheck") S.globalKeyHandler = null;

  if (S.mode === "pcommits") {
    pushBody("  " + BOLD + WHITE + "Select commit for " + S.pluginItems[S.pcursor].name + RST, false);
    for (var i = 0; i < S.commitItems.length; i++) {
      var c = S.commitItems[i];
      var sel = i === S.ccursor;
      var arrow = sel ? (ACCENT + " ❯ " + RST) : "   ";
      var bg = sel ? BG_SEL : "";
      var nameStyle = sel ? (BOLD + WHITE) : DIM;
      pushBody("  " + bg + arrow + nameStyle + c.hash + RST + bg + "  " + pad(c.time, 12) + "  " + trunc(c.subject, Math.max(10, cols - 30)) + RST, sel);
    }
    pushBody("", false);

    if (S.message) {
      pushFoot(messageLine(cols));
    }
    pushFoot("  " + rule(barW));
    pushFoot(hints([["↑↓", "move"], ["enter", "checkout"], ["esc", "cancel"]]));
    return;
  }

  if (S.mode === "pconfig" || S.mode === "pcfginput") {
    var ct = S.configTarget;
    var cname = (ct && ct.name) || "";
    pushBody("  " + BOLD + WHITE + "Configure " + trunc(cname, cols - 16) + RST, false);
    pushBody("  " + GRAY + "changes save to config/" + cname + ".json (restart to apply)" + RST, false);
    pushBody("", false);
    var keyW = 6;
    for (var ck = 0; ck < S.configItems.length; ck++) keyW = Math.max(keyW, stringWidth(S.configItems[ck].key));
    keyW = Math.min(keyW, Math.max(12, Math.floor(cols / 2)));
    for (var ci = 0; ci < S.configItems.length; ci++) {
      var it = S.configItems[ci];
      var csel = ci === S.cfgcursor;
      var editing = S.mode === "pcfginput" && csel;
      var valStr;
      var mark = "";
      if (it.kind === "action") valStr = GRAY + "↵ run" + RST;
      else {
        if (editing) valStr = BG_SEL + " " + (it.type === "secret" ? entryMask(S.inputBuf) : S.inputBuf) + BOLD + "|" + RST;
        else if (it.type === "boolean") valStr = (isBooleanRowOn(it.value) ? OK + "true" : GRAY + "false") + RST;
        else if (it.type === "secret" && S.cfgReveal !== it.key) valStr = GRAY + secretMask(it.value) + RST;
        else valStr = WHITE + JSON.stringify(it.value) + RST;
        mark = it.isSet ? "" : (GRAY + " (default)" + RST);
      }
      var carrow = csel ? (ACCENT + " ❯ " + RST) : "   ";
      var cbg = csel ? BG_SEL : "";
      var cNameStyle = csel ? (BOLD + WHITE) : DIM;
      pushBody("  " + cbg + carrow + cNameStyle + pad(trunc(it.key, keyW), keyW) + RST + cbg + "  " + valStr + mark + RST, csel);
    }
    pushBody("", false);
    if (S.message) pushFoot(messageLine(cols));
    pushFoot("  " + rule(barW));
    var hasSecret = S.configItems.some(function (row: SettingsRow) { return row.kind !== "action" && row.type === "secret"; });
    if (S.mode === "pcfginput") pushFoot(hints([["enter", "save"], ["esc", "cancel"]]));
    else pushFoot(hints(hasSecret ? [["↑↓", "move"], ["enter", "edit/toggle"], ["r", "reveal"], ["esc", "back"]] : [["↑↓", "move"], ["enter", "edit/toggle"], ["esc", "back"]]));
    return;
  }

  if (S.mode === "pdiag" && S.pluginItems.length > 0 && S.pluginItems[S.pcursor]) {
    var dpitem = S.pluginItems[S.pcursor];
    pushBody("  " + BOLD + WHITE + trunc(dpitem.name, cols - 6) + RST, false);
    pushBody("  " + GRAY + "what the plugin host recorded for this plugin" + RST, false);
    pushBody("", false);
    var dlines = diagnosticLines(ledgerRowFor(hostPluginId(dpitem)));
    for (var dj = 0; dj < dlines.length; dj++) {
      var style = dj === 0 ? WHITE : DIM;
      if (dlines[dj].indexOf("Reason: ") === 0 || dlines[dj].indexOf("Unresolved: ") === 0) style = RED;
      pushBody("    " + style + trunc(dlines[dj], Math.max(20, cols - 8)) + RST, false);
    }
    pushBody("", false);
    if (S.message) pushFoot(messageLine(cols));
    pushFoot("  " + rule(barW));
    pushFoot(hints([["esc/enter", "back"], ["q", "quit"]]));
    return;
  }

  if (S.mode === "pactions" && S.pluginItems.length > 0 && S.pluginItems[S.pcursor]) {
    var ppitem = S.pluginItems[S.pcursor];
    pushBody("  " + BOLD + WHITE + "" + trunc(ppitem.name, cols - 6) + RST, false);
    var pinfo = ppitem.type === "npm"
      ? ("npm  " + (ppitem.version ? vlabel(ppitem.version) : "not installed"))
      : trunc(ppitem.subject || ppitem.url || "", cols - 6);
    if (pinfo) pushBody("  " + GRAY + pinfo + RST, false);
    pushBody("", false);
    var pacts = getPluginActions(ppitem);
    var lastCat = null;
    for (var pj = 0; pj < pacts.length; pj++) {
      var pcat = pacts[pj].cat;
      if (pcat && pcat !== lastCat) {
        if (lastCat !== null) pushBody("", false);   // blank line between categories
        pushBody("    " + BOLD + WHITE + pcat + RST, false);
        lastCat = pcat;
      }
      if (pj === S.pacursor) {
        pushBody("    " + ACCENT + "❯ " + BOLD + ACCENT + pacts[pj].label + RST, true);
      } else {
        pushBody("    " + DIM + "  " + pacts[pj].label + RST, false);
      }
    }
    pushBody("", false);
    if (S.message) pushFoot(messageLine(cols));
    pushFoot("  " + rule(barW));
    pushFoot(hints([["↑↓", "move"], ["enter", "confirm"], ["esc", "back"]]));
    return;
  }

  // Only short-circuit the Installed tab when empty; the Marketplace/Providers tabs
  // build their own lists (S.marketplaceItems / custom tabs) and must render even
  // when no plugins are installed yet.
  if (S.pluginItems.length === 0 && S.pluginSubPage === "installed") {
    var tabInstalledEmpty = BOLD + ACCENT + BG_SEL + " Installed " + RST;
    var tabMarketplaceEmpty = GRAY + " Marketplace " + RST;
    pushBody("  " + tabInstalledEmpty + "  " + tabMarketplaceEmpty + "    " + DIM + "tab switch" + RST, false);
    pushBody("", false);
    pushBody("  " + GRAY + "No plugins configured." + RST, false);
    pushBody("  " + GRAY + "Press " + WHITE + "Tab" + GRAY + " to browse the Marketplace." + RST, false);
    pushBody("", false);

    pushFoot("  " + rule(barW));
    pushFoot(hints([["tab", "switch"], ["q", "quit"]]));
    return;
  }

  var tabInstalled = S.pluginSubPage === "installed" ? (BOLD + ACCENT + BG_SEL + " Installed " + RST) : (GRAY + " Installed " + RST);
  var tabMarketplace = S.pluginSubPage === "marketplace" ? (BOLD + ACCENT + BG_SEL + " Marketplace " + RST) : (GRAY + " Marketplace " + RST);
  var tabsLine = "  " + tabInstalled + "  " + tabMarketplace;
  for (var cti = 0; cti < S.customTabs.length; cti++) {
    var ctab = S.customTabs[cti];
    var ctStr = S.pluginSubPage === ctab.id ? (BOLD + ACCENT + BG_SEL + " " + ctab.label + " " + RST) : (GRAY + " " + ctab.label + " " + RST);
    tabsLine += "  " + ctStr;
  }
  tabsLine += "    " + DIM + "tab switch" + RST;
  pushSticky(tabsLine);
  pushSticky("");

  // --- Marketplace sub-page (two levels: markets -> a marketplace's plugins) ---
  if (S.pluginSubPage === "marketplace") {
    // Actions menu for a selected Level-2 plugin (Level 1 never sets mkMode="actions";
    // Enter there always drills in, see input.ts).
    if (S.mkMode === "actions" && S.marketplaceItems.length > 0) {
      var mitem = S.marketplaceItems[S.mkCursor];
      if (!mitem) { S.mkMode = "browse"; }
      else {
        pushBody("  " + BOLD + WHITE + "" + trunc(mitem.name, cols - 6) + RST, false);
        pushBody("  " + GRAY + trunc(mitem.desc || "", cols - 6) + RST, false);
        pushBody("", false);
        var mkActs = getMarketplaceActions(mitem, S.hasUpdater);
        for (var ai = 0; ai < mkActs.length; ai++) {
          var a = mkActs[ai];
          var aSel = ai === S.mkAcursor;
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
    }

    if (S.mkLevel !== "plugins") {
      // --- Level 1: the marketplace-of-marketplaces list ---
      var marketRows = S.marketplaceItems.filter(function(m) { return !m.isAction; });
      pushSticky("  " + BOLD + WHITE + "Marketplaces" + RST + GRAY + " (" + marketRows.length + ")" + RST + (S.mode === "search" || S.inputBuf ? " " + BG_SEL + " Search: " + S.inputBuf + (S.mode === "search" ? "_" : "") + " " + RST : " " + DIM + "(press / to search)" + RST));
      pushSticky("");
      if (marketRows.length === 0 && S.inputBuf) {
        pushBody("  " + GRAY + "No results for \"" + S.inputBuf + "\"" + RST, false);
      }
      var mktPrevAction = false;
      for (var mi = 0; mi < S.marketplaceItems.length; mi++) {
        var mktItem = S.marketplaceItems[mi];
        var mktSel = mi === S.mkCursor;
        var mktArrow = mktSel ? (ACCENT + " ❯ " + RST) : "   ";
        var mktBg = mktSel ? BG_SEL : "";
        // Unified Add-row style, identical to views/mcp.ts's "＋ Add MCP server" row
        // (BOLD+ACCENT when selected, DIM otherwise; no separate status column).
        if (mktItem.isAction) {
          pushBody("  " + mktBg + mktArrow + (mktSel ? (BOLD + ACCENT) : DIM) + mktItem.name + RST, mktSel);
          mktPrevAction = true;
          continue;
        }
        if (mktPrevAction) {
          pushBody("", false);   // gap between the leading action rows and real content
          mktPrevAction = false;
        }
        var mktNameStyle = mktSel ? (BOLD + WHITE) : DIM;
        var mktNameW = Math.min(34, Math.max(20, nameW));
        var countLabel = typeof mktItem.count === "number" ? (mktItem.count + (mktItem.count === 1 ? " plugin" : " plugins")) : "…";
        pushBody("  " + mktBg + mktArrow + mktNameStyle + pad(trunc(mktItem.name, mktNameW), mktNameW) + RST + mktBg + "  " + GRAY + pad(countLabel, 12) + RST + DIM + trunc(mktItem.source || "", Math.max(10, cols - mktNameW - 26)) + RST, mktSel);
      }
      pushBody("", false);
      if (S.message) { pushFoot(messageLine(cols)); }
      pushFoot("  " + rule(barW));
      if (S.mode === "mkinput") {
        var mkLabel = S.mkAddAction === "add_marketplace" ? "Marketplace (url or owner/repo): " : "Git URL: ";
        pushFoot("  " + ACCENT + mkLabel + RST + S.inputBuf + BOLD + "|" + RST);
        pushFoot(hints([["enter", "confirm"], ["esc", "cancel"]]));
        return;
      }
      pushFoot(hints([["↑↓", "move"], ["enter", "open"], ["/", "search"], ["?", "help"], ["q", "quit"]]));
      return;
    }

    // --- Level 2: the drilled-in marketplace's plugins ---
    var catalogItems = S.marketplaceItems;   // no leading action rows at Level 2
    var mkHeader = "  " + DIM + "‹ " + RST + BOLD + WHITE + trunc(S.mkMarket || "", 34) + RST + GRAY + " (" + catalogItems.length + " available)" + RST;
    mkHeader += (S.mode === "search" || S.inputBuf) ? " " + BG_SEL + " Search: " + S.inputBuf + (S.mode === "search" ? "_" : "") + " " + RST : " " + DIM + "(press / to search)" + RST;
    pushSticky(mkHeader);
    if (catalogItems.length === 0) {
      if (S.inputBuf) {
        pushBody("  " + GRAY + "No results for \"" + S.inputBuf + "\"" + RST, false);
      } else if (S.catalogPending > 0) {
        pushBody("  " + spinnerFrame() + GRAY + " Loading marketplace catalog..." + RST, false);
      } else {
        pushBody("  " + GRAY + "No plugins found in this marketplace." + RST, false);
      }
    }

    // section header whenever the plugin's category changes (a source's entries by
    // their capability-derived category, "Community"/"Curated" for the built-in
    // catalog, the curated Featured list by its own `category` field such as Memory
    // or Statusline; a single "From <source>" group for a capability marketplace);
    // also the unit [ / ] fast-nav jumps between.
    var lastGroup = null;
    var hasNpm = !!appNpmPlugins();
    for (var pi2 = 0; pi2 < S.marketplaceItems.length; pi2++) {
      var mitem = S.marketplaceItems[pi2];
      var group = mitem.category || ((mitem.capability || mitem.seed) ? "From " + (mitem.source || S.mkMarket) : "Community");
      if (group !== lastGroup) {
        pushBody("", false);
        pushBody("  " + BOLD + WHITE + group + RST, false);
        lastGroup = group;
      }

      var msel = pi2 === S.mkCursor;
      var mkNameW = Math.min(30, nameW);
      var methodW = (!hasNpm || mitem.capability || mitem.seed) ? 0 : 4;
      // the method badge only means something where the app has a second install method
      var methodBadge = (!hasNpm || mitem.capability || mitem.seed) ? ""
        : mitem.installed ? "    "
        : (OK + "git " + RST);
      // status circle: installed = dim ●, selected = accent ◉, selectable = ○
      var circle = mitem.installed ? (DIM + "●" + RST)
        : (S.mkSelected[selectionKey(mitem)] ? (ACCENT + "◉" + RST) : (GRAY + "○" + RST));
      pushBody(marketplaceRow(cols, { selected: msel, name: mitem.name, nameW: mkNameW, desc: mitem.desc, stars: mitem.stars, statusIcon: circle, badge: methodBadge, badgeW: methodW }), msel);
      if (msel && mitem.url) {
        // indent to align under the name column: 2 + 3(cursor) + 1(circle) + 1(space) + method
        var urlIndent = 7 + methodW;
        pushBody("  " + GRAY + " ".repeat(urlIndent - 2) + trunc(mitem.url, cols - urlIndent) + RST, msel);
      }
    }
    pushBody("", false);
    if (S.message) { pushFoot(messageLine(cols)); }
    pushFoot("  " + rule(barW));
    if (S.mode === "mkinput") {
      var mkLabel2 = S.mkAddAction === "add_marketplace" ? "Marketplace (url or owner/repo): " : "Git URL: ";
      pushFoot("  " + ACCENT + mkLabel2 + RST + S.inputBuf + BOLD + "|" + RST);
      pushFoot(hints([["enter", "confirm"], ["esc", "cancel"]]));
      return;
    }
    var selCount = Object.keys(S.mkSelected).length;
    if (selCount > 0) {
      pushFoot("  " + BOLD + ACCENT + selCount + " selected" + RST + GRAY + " · space toggle · i install · esc back" + RST);
    }
    pushFoot(hints([["↑↓", "move"], ["[ ]", "jump group"], ["enter", "select"], ["space", "select"], ["/", "search"], ["esc", "back"], ["?", "help"]]));
    return;
  }

  // --- Custom tab sub-pages (rendered by plugin extensions) ---
  var activeTab = S.customTabs.find(function(t) { return t.id === S.pluginSubPage; });
  if (activeTab && activeTab.render) {
    try {
      activeTab.render({
        pluginSubPage: S.pluginSubPage,
        cols: cols,
        nameW: nameW,
        message: S.message,
        mode: S.mode
      }, {
        pushBody: pushBody,
        pushSticky: pushSticky,
        pushFoot: pushFoot,
        pad: pad,
        trunc: trunc,
        BOLD: BOLD, WHITE: WHITE, BG_SEL: BG_SEL, RST: RST,
        GRAY: GRAY, DIM: DIM, YELLOW: YELLOW, GREEN: GREEN,
        MAGENTA: MAGENTA, CYAN: CYAN, RED: RED,
        // palette tokens so custom tabs (e.g. the Providers tab) match the theme:
        // ACCENT = the per-loader accent, OK/BAD = muted status tones.
        ACCENT: ACCENT, OK: OK, BAD: BAD, INFO: INFO,
        barW: barW
      });
    } catch(e) {}
    return;
  }

  // --- Installed sub-page (existing code) ---
  var autoCount = 0, manualCount = 0, updateCount = 0, disabledCount = 0;
  for (var p of S.pluginItems) {
    if (p.type === "npm" || p.foreign) continue;
    if (!p.enabled) disabledCount++;
    else if (p.autoUpdate) autoCount++; else manualCount++;
    if (p.updateAvail) updateCount++;
  }

  var npmCount = S.pluginItems.filter(function(p) { return p.type === "npm"; }).length;
  // Top info block stays pinned (sticky) so it never scrolls off behind an "↑ N more".
  pushSticky("  " + BOLD + WHITE + "Plugins" + RST + " " +
      GRAY + "(" + autoCount + " auto, " + manualCount + " manual, " + disabledCount + " disabled" +
      (updateCount > 0 ? ", " + ACCENT + updateCount + " updates" + GRAY : "") +
      (npmCount > 0 ? ", " + GRAY + npmCount + " npm" + GRAY : "") +
      ")" + RST);

  // Makes background auto-updates (applied at app start, before
  // the TUI ever ran) visible; otherwise a silent pull looks indistinguishable from
  // "nothing happened". Reads the same cache buildPluginList/buildCombinedPluginList
  // already consulted; absent cache (never checked yet) shows nothing.
  var updCache = readUpdateCache();
  var updCheckedMs = updCache && updCache.checkedAt ? Date.parse(updCache.checkedAt) : NaN;
  if (updCache && !isNaN(updCheckedMs)) {
    var justUpdatedCount = 0;
    for (var upi = 0; upi < S.pluginItems.length; upi++) {
      if (S.pluginItems[upi].updatedAt && S.pluginItems[upi].updatedAt === updCache.checkedAt) justUpdatedCount++;
    }
    pushSticky("  " + DIM + "update check: " + timeAgo(updCheckedMs) + RST +
        (justUpdatedCount > 0 ? GRAY + " · " + ACCENT + justUpdatedCount + " updated" + RST : ""));
  }

  pushSticky("");   // spacer between the count and the engine/locations block

  var abbr = function(pth: string | undefined) { return (pth && HOME && String(pth).indexOf(HOME) === 0) ? "~" + String(pth).slice(HOME.length) : pth; };
  // An app with an npm-plugin mechanism already carries its engine as an npm row, so naming the
  // manager here too would report the same thing twice.
  if (!appNpmPlugins()) {
    var mref = resolvedManager();
    var uv = getUpdaterVersion();
    pushSticky("  " + DIM + "manager " + (mref ? mref.id : "(unresolved)") + (uv ? " v" + uv : "") + GRAY + (getUpdaterPath() ? " · " + abbr(getUpdaterPath()) : "") + RST);
  }
  var npmPlugins = appNpmPlugins();
  var npmCache = npmPlugins && npmPlugins.packageCache ? expandPath(npmPlugins.packageCache, CONFIG_DIR) : "";
  pushSticky("  " + DIM + "git " + abbr(PLUGINS_DIR) + GRAY + " · clones " + abbr(REPOS_DIR) + (npmCache ? " · npm " + abbr(npmCache) : "") + RST);

  pushSticky("");   // spacer between the locations block and the plugin list

  if (!S.pluginFetched) {
    pushSticky("  " + DIM + "Press F to check for updates" + RST);
  }

  var hadNpm = false;
  for (var i = 0; i < S.pluginItems.length; i++) {
    var pitem = S.pluginItems[i];
    if (pitem.type === "npm" && (i === 0 || S.pluginItems[i - 1].type !== "npm")) {
      hadNpm = true;
      pushBody("", false);
      pushBody("  " + BOLD + WHITE + "npm plugins" + RST, false);
    }
    if (pitem.foreign && (i === 0 || !S.pluginItems[i - 1].foreign)) {
      pushBody("", false);
      pushBody("  " + BOLD + WHITE + "App plugins" + RST + GRAY + " (managed by " + APP_NAME + ")" + RST, false);
    }
    buildPluginItem(pushBody, i, pitem, nameW, cols, i === S.pcursor);
  }

  // an app with an npm-plugin mechanism gets the section even when empty, pointing at the Marketplace
  if (!hadNpm && appNpmPlugins()) {
    pushBody("", false);
    pushBody("  " + BOLD + WHITE + "npm plugins" + RST, false);
    pushBody("  " + DIM + "none installed - add from the Marketplace" + RST, false);
  }

  pushBody("", false);

  if (S.message) {
    pushFoot(messageLine(cols));
  }
  pushFoot("  " + rule(barW));

  if (S.mode === "pinput") {
    pushFoot("  " + ACCENT + "Plugin git URL: " + RST + S.inputBuf + BOLD + "|" + RST);
    pushFoot(hints([["enter", "add"], ["esc", "cancel"]]));
  } else {
    pushFoot(hints([["↑↓", "move"], ["enter", "select"], ["tab", "switch"], ["?", "help"], ["q", "quit"]]));
  }
}

