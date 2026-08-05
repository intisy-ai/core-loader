// @ts-nocheck
// Keyboard handling: key parsing and the per-page key handlers (projects,
// plugins, mcp, confirm dialog) plus the text-input handlers.

import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { RST, BOLD, WHITE, RED } from "./format.js";
import { APP_NAME, CONFIG_DIR, HOME, PLUGINS_DIR, REPOS_DIR, MCP_CONFIG_PATH, OFFICIAL_PLUGINS } from "./env.js";
import { S } from "./state.js";
import { cleanup } from "./out.js";
import { loadConfig, saveConfig, loadPlugins, savePlugins, loadGlobalSettings, setGlobalSetting, GLOBAL_SETTINGS_DEFAULTS } from "./config.js";
import { getUpdater, setupPlugin, installUpdater, updateUpdater, preloadUpdater, clearUpdaterCache } from "./updater.js";
import { openProject, openProjectSession, listSessions, togglePin, hideItem, unhideAll, changeProjectPath, outputDir, getActions } from "./projects.js";
import { getPluginActions, buildCombinedPluginList, fetchPluginRemotes, probeConfigSchema, buildConfigItems, setPluginConfig } from "./plugins.js";
import { buildMarketplaceList, installMarketplacePlugin, installViaNpm, selectInstallMethod, getMarketplaceActions, invalidateCatalogCache, fetchCatalogsAsync, invalidateSeedCache, fetchSeedMarketplacesAsync } from "./marketplace.js";
import { selectionKey, selectedInstallables } from "./selection.js";
import { buildMcpList, installMcpServer, uninstallMcpServer, getMcpActions, buildInstalledMcpRows } from "./mcp.js";
import { flash } from "./views/common.js";
import { refreshSettings } from "./views/settings.js";
import { getConfigLedger, configLedgerReady, configLedgerInstalled, preloadConfigLedger } from "./config-ledger.js";
import { refreshVersioning, reconcileConfigLedger, VG_INIT_OPTS, VG_MENU_ITEMS } from "./views/versioning.js";
import { buildGlobalSection, buildPluginSections } from "./settings-model.js";
import { render } from "./views/render.js";
import { tuiApi } from "./tui.js";
import { emitLoaderActivity } from "./activity-seam.js";

// Enter on a config row: a boolean flips, a field with a declared choice list steps to
// its next option, anything else opens the text input. Shared by both config editors so
// the write path exists once.
function activateConfigItem(citem, textMode) {
  if (!citem) return;
  var next = null;
  if (citem.type === "boolean") next = !citem.value;
  else if (Array.isArray(citem.options) && citem.options.length) {
    var values = citem.options.map(function (o) { return typeof o === "string" ? o : o.value; });
    var at = values.indexOf(String(citem.value));
    next = values[(at + 1) % values.length];
  }
  if (next === null) {
    S.configEditKey = citem.key;
    S.inputBuf = (citem.value === undefined || citem.value === null) ? "" : String(citem.value);
    S.mode = textMode;
    return;
  }
  var err = S.configTarget.global
    ? setGlobalSetting(citem.key, String(next))
    : setPluginConfig(S.configTarget.bundle, citem.key, String(next));
  if (err) { flash(citem.key + ": " + err); return; }
  refreshConfigItems();
  flash(citem.key + " = " + next + " (restart to apply)");
}

// The activity reader is injected (core-loader reads no log itself), so the impact
// filter travels as a query. A host whose reader ignores the argument simply returns
// everything, which is why the filter is applied by the reader and not re-applied here.
function readActivityRecords() {
  var readFn = S.capabilities && S.capabilities.activity && S.capabilities.activity.read;
  if (typeof readFn !== "function") return [];
  var query = { limit: 200 };
  var impacts = S.activityImpacts || [];
  if (impacts.length) query.impacts = impacts.slice();
  try { return readFn(query) || []; } catch (e) { return []; }
}

// Ordered so one key walks from "only what broke" to "everything worth reading".
var IMPACT_CYCLE = [[], ["error"], ["error", "warning"], ["notice", "warning", "error"]];

function cycleImpactFilter() {
  var current = JSON.stringify(S.activityImpacts || []);
  var at = 0;
  for (var i = 0; i < IMPACT_CYCLE.length; i++) {
    if (JSON.stringify(IMPACT_CYCLE[i]) === current) { at = i; break; }
  }
  S.activityImpacts = IMPACT_CYCLE[(at + 1) % IMPACT_CYCLE.length].slice();
}

// Plugin lifecycle facts share one vocabulary with plugin-updater's, so a reader sees
// the same actions whoever performed them. Only actions this menu performs ITSELF are
// reported here: what it delegates to plugin-updater, plugin-updater already reports.
function reportPluginAction(action, name, details) {
  emitLoaderActivity({
    topic: "plugin.installed",
    action: action,
    impact: "notice",
    outcome: "ok",
    subject: { kind: "plugin", id: name, label: name },
    details: details || {},
  });
}

// Open a project through the session picker. Sessions come from the active
// app's listSessions capability (absent -> none, picker skipped). With no prior
// sessions, launch fresh immediately: "Open here" keeps the exit-42 path so the
// wrapper forwards the user's own cc args; a project row writes its dir.
function enterSessions(dir, here) {
  var sessions = listSessions(dir);
  if (!sessions.length) {
    if (here) { cleanup(); process.exit(42); } else { openProjectSession(dir, null); }
    return;
  }
  S.sessionItems = sessions; S.scursor = 0; S.sessionDir = dir; S.sessionHere = here;
  S.mode = "sessions"; S.scrollOff = 0;
}

// Set a persistent status message for a long busy action. Unlike flash(), it does
// NOT auto-clear after 2.5s; the message (and its "..." spinner) stays up until
// the completion callback flashes the result. Clears any pending flash timeout.
function setBusyMessage(msg) {
  if (S.msgTimeout) { clearTimeout(S.msgTimeout); S.msgTimeout = null; }
  S.message = msg;
}

// Update a list of plugins off-thread with a BOUNDED CONCURRENCY POOL: each plugin is
// an independent git repo + child process, so running a few at once cuts update-all
// wall-clock roughly by the pool size vs updating them one at a time. Progress shows
// "Updating plugins (done/N)..."; the final callback rebuilds the list, flashes a
// summary, and runs onDone (cursor clamp). Used by update-all ('a' key + action) and
// single update.
var UPDATE_POOL_SIZE = 4;
function runUpdateSequence(toUpdate, onDone) {
  S.busy = true;
  var errors = [];
  var started = 0;
  var finished = 0;
  var plugins = loadPlugins();
  var progress = function() {
    setBusyMessage(toUpdate.length > 1
      ? ("Updating plugins (" + finished + "/" + toUpdate.length + ")...")
      : ("Updating " + toUpdate[0].name + "..."));
    render();
  };
  var finishAll = function() {
    S.pluginItems = buildCombinedPluginList();
    S.busy = false;
    flash(errors.length > 0 ? errors.join("; ") : toUpdate.length + " plugin(s) updated. Restart " + APP_NAME + " to apply.");
    if (onDone) onDone();
    render();
  };
  if (toUpdate.length === 0) { finishAll(); return; }
  var startNext = function() {
    if (started >= toUpdate.length) return;
    var pi = toUpdate[started++];
    var repo = plugins.find(function(r) { return r.name === pi.name; });
    setupPlugin(repo || pi, function(e) {
      if (e) errors.push(pi.name + ": " + e);
      finished++;
      if (finished >= toUpdate.length) finishAll();
      else { progress(); startNext(); }
    });
  };
  progress();
  for (var i = 0; i < Math.min(UPDATE_POOL_SIZE, toUpdate.length); i++) startNext();
}

// Cycle the plugins sub-tab (Installed -> Marketplace -> custom tabs -> Installed).
// Exported so the "updater missing" gate handler in tui.ts can move the user off
// the gated Installed tab onto the Marketplace with the same mechanics as Tab here.
export function switchPluginSubPage() {
  S.inputBuf = "";
  if (S.pluginSubPage === "installed") {
    S.pluginSubPage = "marketplace";
    S.mkLevel = "markets"; S.mkMarket = null; S.mkMarketKind = null; S.mkSelected = {};
    S.marketplaceItems = buildMarketplaceList(); S.mkCursor = 0; S.mkScrollOff = 0;
  }
  else if (S.pluginSubPage === "marketplace" && S.customTabs.length > 0) { S.pluginSubPage = S.customTabs[0].id; }
  else if (S.pluginSubPage === "marketplace") { S.pluginSubPage = "installed"; }
  else {
    var cIdx = S.customTabs.findIndex(function(t) { return t.id === S.pluginSubPage; });
    if (cIdx >= 0 && cIdx < S.customTabs.length - 1) {
      S.pluginSubPage = S.customTabs[cIdx + 1].id;
    } else {
      S.pluginSubPage = "installed";
    }
  }
}

// Fast nav within a (potentially long) Level-2 marketplace: jump the cursor to
// the start of the previous/next category group ("Official"/"Community"/"Curated"
// for the loader's own two catalogs). A capability marketplace's plugins carry no
// category, so there is only one implicit group there; in that case (or any
// single-group list) fall back to a 10-row page jump so the keys stay useful.
function jumpMarketplaceGroup(dir) {
  var items = S.marketplaceItems;
  if (items.length === 0) return;
  var groupOf = function(it) { return it.category || (it.official ? "Official" : it.capability ? "capability" : "Community"); };
  var boundaries = [];
  for (var i = 0; i < items.length; i++) {
    if (i === 0 || groupOf(items[i]) !== groupOf(items[i - 1])) boundaries.push(i);
  }
  if (boundaries.length <= 1) {
    S.mkCursor = Math.max(0, Math.min(items.length - 1, S.mkCursor + dir * 10));
    return;
  }
  if (dir > 0) {
    var next = boundaries.find(function(b) { return b > S.mkCursor; });
    S.mkCursor = next !== undefined ? next : items.length - 1;
  } else {
    var before = boundaries.filter(function(b) { return b < S.mkCursor; });
    S.mkCursor = before.length ? before[before.length - 1] : 0;
  }
}

// Route a marketplace entry to the right installer: the engine itself (isUpdater)
// goes through the app-aware installUpdater; everything else through the git/npm
// path selectInstallMethod chooses. Calls done(errOrNull, methodLabel).
function marketplaceInstall(item, done, forceMethod) {
  if (item.isUpdater) {
    var uerr = installUpdater(CONFIG_DIR, APP_NAME);
    S.hasUpdater = false;   // re-detect on next render now the engine is set up
    done(uerr || null, "updater");
    return;
  }
  var method = forceMethod || selectInstallMethod(item, S.hasUpdater);
  var install = method === "git" ? installMarketplacePlugin : installViaNpm;
  install(item, function(err) { done(err, method); });
}

// Install a plugin browsed from a SEEDED default marketplace (not yet added to
// the host app, see marketplace.ts's DEFAULT_MARKETPLACES / getMarketplaceActions
// "install-seed"): register the marketplace first (capabilities.addMarketplace),
// then install the plugin from it (capabilities.installAppPlugin); one user
// action does both. Both calls are guarded (absent capability -> graceful flash,
// same as a capability-marketplace row); `done()` always runs so the caller can
// refresh the list/cursor and re-render.
function installSeedPlugin(item, done) {
  var addMkFn = S.capabilities && S.capabilities.addMarketplace;
  var installAppFn = S.capabilities && S.capabilities.installAppPlugin;
  if (typeof addMkFn !== "function" || typeof installAppFn !== "function") {
    flash("Not installable from here yet.");
    done();
    return;
  }
  S.busy = true;
  setBusyMessage("Adding " + (item.repo || item.source) + "...");
  render();
  var addRes;
  try { addRes = addMkFn(item.repo || item.source); }
  catch (e) { addRes = { ok: false, error: (e && e.message) || String(e) }; }
  if (!addRes || !addRes.ok) {
    S.busy = false;
    flash("Failed to add marketplace: " + ((addRes && addRes.error) || ""));
    done();
    return;
  }
  setBusyMessage("Installing " + item.name + "...");
  render();
  var iares;
  try { iares = installAppFn(item.id, item.source); }
  catch (e) { iares = { ok: false, error: (e && e.message) || String(e) }; }
  S.busy = false;
  flash(iares && iares.ok ? ("Installing " + item.name + "… restart to activate") : ("Failed: " + ((iares && iares.error) || "")));
  done();
}

export function handleKey(key) {
  // A long install/update is running off-thread; ignore every key so the user
  // stays in the current menu and can't navigate away or fire another action.
  if (S.busy) return;
  if (S.helpOpen) { S.helpOpen = false; return; }
  if (key === "?" && S.mode === "list") { S.helpOpen = true; return; }
  // Page switching with left/right (only in list mode, not in actions/input)
  if ((S.mode === "list") && (key === "left" || key === "right")) {
    // "activity" only joins the cycle once its capability is injected, so the
    // cycle stays contiguous when the host loader hasn't registered it.
    var pages = ["projects", "plugins", "mcp"];
    if (S.capabilities && S.capabilities.activity) pages.push("activity");
    pages.push("settings");
    var pi = pages.indexOf(S.page);
    var switchTo = function (np) {
      S.page = np; S.mode = "list";
      S.globalKeyHandler = null;   // leaving the updater gate: don't let it intercept keys on the new tab
      // landing on Settings with the Versioning sub-tab active → re-detect config-ledger
      if (np === "settings" && S.settingsSubPage === "versioning") { try { reconcileConfigLedger(); } catch (e) {} }
      if (np === "activity") {
        S.activityRecords = readActivityRecords();
        S.activityCursor = 0;
      }
      render();
    };
    if (key === "left" && pi > 0) { switchTo(pages[pi - 1]); return; }
    if (key === "right" && pi < pages.length - 1) { switchTo(pages[pi + 1]); return; }
    return;
  }

  if (S.mode === "confirm") {
    handleConfirmKey(key);
  } else if (S.page === "projects") {
    handleProjectKey(key);
  } else if (S.page === "mcp") {
    handleMcpKey(key);
  } else if (S.page === "activity") {
    handleActivityKey(key);
  } else if (S.page === "settings") {
    handleSettingsKey(key);
  } else {
    handlePluginKey(key);
  }
}

export function handleProjectKey(key) {
  if (S.mode === "list") {
    if (key === "up" || key === "w") { S.cursor = Math.max(0, S.cursor - 1); }
    else if (key === "down" || key === "s") { S.cursor = Math.min(S.items.length, S.cursor + 1); }
    else if (key === "enter" || key === "space") {
      if (S.cursor === S.items.length) { enterSessions(process.cwd(), true); }
      else if (S.items.length > 0) { S.mode = "actions"; S.acursor = 0; }
    }
    else if (key === "o") {
      if (S.cursor === S.items.length) { cleanup(); process.exit(42); }
      else if (S.items.length > 0) openProject(S.items[S.cursor]);
    }
    else if (key === "p") { if (S.cursor < S.items.length) togglePin(S.cursor); }
    else if (key === "h") { if (S.cursor < S.items.length) hideItem(S.cursor); }
    else if (key === "u") { unhideAll(); }
    else if (key === "c") { S.mode = "input"; S.inputBuf = ""; }
    else if (key === "q" || key === "escape") { cleanup(); process.exit(1); }
  } else if (S.mode === "actions") {
    var acts = getActions(S.items[S.cursor]);
    if (key === "up" || key === "w") { S.acursor = Math.max(0, S.acursor - 1); }
    else if (key === "down" || key === "s") { S.acursor = Math.min(acts.length - 1, S.acursor + 1); }
    else if (key === "enter" || key === "space") {
      var action = acts[S.acursor].key;
      if (action === "open") { enterSessions(S.items[S.cursor].dir, false); }
      else if (action === "pin" || action === "unpin") { togglePin(S.cursor); S.mode = "list"; }
      else if (action === "hide") { hideItem(S.cursor); S.mode = "list"; }
      else if (action === "chpath") { S.mode = "input"; S.chpathDir = S.items[S.cursor].dir; S.inputBuf = S.items[S.cursor].dir; }
      else if (action === "unhide") { unhideAll(); S.mode = "list"; }
      else { S.mode = "list"; }
    }
    else if (key === "escape" || key === "q" || key === "left") { S.mode = "list"; }
  } else if (S.mode === "sessions") {
    var n = S.sessionItems.length;
    if (key === "up" || key === "w") { S.scursor = Math.max(0, S.scursor - 1); }
    else if (key === "down" || key === "s") { S.scursor = Math.min(n, S.scursor + 1); }
    else if (key === "enter" || key === "space") {
      if (S.scursor === 0) {
        if (S.sessionHere) { cleanup(); process.exit(42); }
        else { openProjectSession(S.sessionDir, null); }
      } else {
        openProjectSession(S.sessionDir, S.sessionItems[S.scursor - 1].id);
      }
    }
    else if (key === "escape" || key === "q") { S.mode = "list"; }
  }
}

export function handlePluginKey(key) {
  if (S.mode === "list") {
    // Esc backs out of the marketplace action menu (it keeps S.mode === "list"
    // and tracks its own S.mkMode) instead of quitting the loader; only the
    // top-level list quits on Esc. `q` always quits.
    if (key === "escape" && S.pluginSubPage === "marketplace" && S.mkMode === "actions") { S.mkMode = "browse"; return; }
    // Esc at Level 2 backs out to Level 1 (the marketplace list) instead of quitting.
    if (key === "escape" && S.pluginSubPage === "marketplace" && S.mkLevel === "plugins") {
      S.mkLevel = "markets"; S.mkMarket = null; S.mkMarketKind = null; S.mkSelected = {}; S.inputBuf = "";
      S.marketplaceItems = buildMarketplaceList(); S.mkCursor = 0; S.mkScrollOff = 0;
      return;
    }
    // `q` always quits, from any sub-page (incl. custom tabs).
    if (key === "q") { cleanup(); process.exit(1); return; }

    if (key === "tab") {
      switchPluginSubPage();
      return;
    }

    var activeTab = S.customTabs.find(function(t) { return t.id === S.pluginSubPage; });
    if (activeTab && activeTab.handleKey) {
      // A custom tab OWNS all its keys, including Esc, so it can back out of its own
      // sub-views (e.g. chain editor -> slots) instead of the core quitting the loader.
      // Quitting from a custom tab is `q` only (handled above).
      try {
        activeTab.handleKey(key, {
          pluginSubPage: S.pluginSubPage,
          mode: S.mode
        }, tuiApi);
      } catch(e) {}
      return;
    }

    // Built-in sub-pages (installed / marketplace top level): Esc quits.
    if (key === "escape") { cleanup(); process.exit(1); return; }


    if (S.pluginSubPage === "marketplace") {
      // Actions sub-mode
      if (S.mkMode === "actions") {
        var mitem = S.marketplaceItems[S.mkCursor];
        if (!mitem) { S.mkMode = "browse"; return; }
        var mkActs = getMarketplaceActions(mitem, S.hasUpdater);
        if (key === "up" || key === "w") { S.mkAcursor = Math.max(0, S.mkAcursor - 1); }
        else if (key === "down" || key === "s") { S.mkAcursor = Math.min(mkActs.length - 1, S.mkAcursor + 1); }
        else if (key === "enter" || key === "space") {
          var action = mkActs[S.mkAcursor].key;
          if (action === "install" || action === "install-git" || action === "install-npm") {
            var forceMethod = action === "install-git" ? "git" : action === "install-npm" ? "npm" : undefined;
            S.mkMode = "browse";
            S.busy = true;
            setBusyMessage("Installing " + (mitem.name || mitem.repoName) + "...");
            render();
            marketplaceInstall(mitem, function(merr, method) {
              S.busy = false;
              if (merr) flash(merr);
              else { flash("Installed (" + method + ")! Restart to activate."); S.pluginItems = buildCombinedPluginList(); }
              S.marketplaceItems = buildMarketplaceList();
              if (S.mkCursor >= S.marketplaceItems.length) S.mkCursor = Math.max(0, S.marketplaceItems.length - 1);
              render();
            }, forceMethod);
            return;
          } else if (action === "install-app") {
            S.mkMode = "browse";
            var installAppFn = S.capabilities && S.capabilities.installAppPlugin;
            var iares = typeof installAppFn === "function" ? installAppFn(mitem.id, S.mkMarket) : { ok: false, error: "not available" };
            flash(iares && iares.ok ? ("Installing " + mitem.name + "… restart to activate") : ("Failed: " + ((iares && iares.error) || "")));
            S.marketplaceItems = buildMarketplaceList();
            if (S.mkCursor >= S.marketplaceItems.length) S.mkCursor = Math.max(0, S.marketplaceItems.length - 1);
            render();
            return;
          } else if (action === "install-seed") {
            S.mkMode = "browse";
            installSeedPlugin(mitem, function() {
              S.marketplaceItems = buildMarketplaceList();
              if (S.mkCursor >= S.marketplaceItems.length) S.mkCursor = Math.max(0, S.marketplaceItems.length - 1);
              render();
            });
            return;
          } else if (action === "browser" && mitem.url) {
            try {
              var openCmd = process.platform === "win32" ? "start \"\" \"" + mitem.url + "\"" : process.platform === "darwin" ? "open \"" + mitem.url + "\"" : "xdg-open \"" + mitem.url + "\"";
              execSync(openCmd, { timeout: 5000, stdio: "ignore" });
              flash("Opened in browser");
            } catch(e) { flash("No browser available: " + mitem.url); }
          }
          S.mkMode = "browse";
        }
        else if (key === "escape" || key === "left") { S.mkMode = "browse"; }
        return;
      }
      // Browse mode
      if (key === "up" || key === "w") { S.mkCursor = Math.max(0, S.mkCursor - 1); }
      else if (key === "down" || key === "s") { S.mkCursor = Math.min(S.marketplaceItems.length - 1, S.mkCursor + 1); }
      else if (key === "[" || key === "]") {
        if (S.mkLevel === "plugins") jumpMarketplaceGroup(key === "]" ? 1 : -1);
      }
      else if (key === "enter") {
        var curItem = S.marketplaceItems[S.mkCursor];
        if (curItem && curItem.isAction) {
          S.mkAddAction = curItem.actionKey;
          S.inputBuf = "";
          S.mode = "mkinput";
          return;
        }
        if (S.mkLevel === "markets") {
          // Drill into the selected marketplace (Level 2). isAction rows were
          // handled above and never reach here.
          if (!curItem) return;
          S.mkMarket = curItem.name;
          S.mkMarketKind = curItem.builtin || (curItem.capability ? "capability" : (curItem.seed ? "seed" : null));
          S.mkLevel = "plugins";
          S.mkCursor = 0;
          S.mkScrollOff = 0;
          S.mkSelected = {};
          S.inputBuf = "";
          S.marketplaceItems = buildMarketplaceList();
          return;
        }
        if (S.marketplaceItems.length > 0) { S.mkMode = "actions"; S.mkAcursor = 0; }
      }
      else if (key === "space") {
        if (S.mkLevel !== "plugins") return;   // Level 1 rows aren't installable/selectable
        var selItem = S.marketplaceItems[S.mkCursor];
        if (selItem && !selItem.isAction) {
          if (selItem.capability) { flash("Not installable from here yet."); }
          else if (selItem.seed) { flash("Press i or Enter to install (adds the marketplace first)."); }
          else if (selItem.installed) { flash((selItem.name || selItem.repoName) + " is already installed."); }
          else {
            var sk = selectionKey(selItem);
            if (S.mkSelected[sk]) delete S.mkSelected[sk];
            else S.mkSelected[sk] = true;
          }
        }
      }
      else if (key === "/") { S.mode = "search"; return; }
      else if (key === "r") {
        invalidateCatalogCache();
        invalidateSeedCache();
        S.catalogFetched = false;
        S.seedFetched = false;
        fetchCatalogsAsync();
        fetchSeedMarketplacesAsync();
        S.marketplaceItems = buildMarketplaceList();
        flash("Refreshing catalog...");
      }
      else if (key === "i") {
        if (S.mkLevel !== "plugins") { flash("Open a marketplace first."); return; }
        // Source from S.marketplaceItems (not the raw catalog) so the synthetic
        // isUpdater entry buildMarketplaceList() injects is visible to the batch;
        // it never appears in S.MARKETPLACE_CATALOG.
        var batch = selectedInstallables(S.marketplaceItems, loadPlugins().map(function(p) { return p.name; }), S.mkSelected);
        if (batch.length > 0) {
          // Install the selection SEQUENTIALLY off-thread: each callback kicks the
          // next, so only one clone runs at a time and the progress count is coherent.
          // marketplaceInstall() routes isUpdater to installUpdater and everything
          // else through selectInstallMethod, same as the single-item install path.
          S.busy = true;
          var failed = [];
          var installNext = function(k) {
            if (k >= batch.length) {
              var okCount = batch.length - failed.length;
              S.mkSelected = {};
              S.busy = false;
              flash(failed.length
                ? ("Installed " + okCount + " · " + failed.length + " failed: " + failed.join(", ") + ". Restart to activate.")
                : ("Installed " + okCount + "! Restart to activate."));
              S.pluginItems = buildCombinedPluginList();
              S.marketplaceItems = buildMarketplaceList();
              if (S.mkCursor >= S.marketplaceItems.length) S.mkCursor = Math.max(0, S.marketplaceItems.length - 1);
              render();
              return;
            }
            var batchItem = batch[k];
            var batchMethod = batchItem.isUpdater ? "updater" : selectInstallMethod(batchItem, S.hasUpdater);
            setBusyMessage("Installing " + (k + 1) + "/" + batch.length + " (" + batchMethod + ")...");
            render();
            marketplaceInstall(batchItem, function(berr) {
              if (berr) failed.push(batchItem.name || batchItem.repoName);
              installNext(k + 1);
            });
          };
          installNext(0);
        } else if (S.marketplaceItems.length > 0) {
          var quickItem = S.marketplaceItems[S.mkCursor];
          if (quickItem.isAction) { return; }   // 'i' is a no-op on the leading action rows
          if (quickItem.installed) { flash((quickItem.name || quickItem.repoName) + " is already installed."); return; }
          if (quickItem.capability) {
            var installAppFn2 = S.capabilities && S.capabilities.installAppPlugin;
            if (typeof installAppFn2 !== "function") { flash("Not installable from here yet."); return; }
            var iares2 = installAppFn2(quickItem.id, S.mkMarket);
            flash(iares2 && iares2.ok ? ("Installing " + quickItem.name + "… restart to activate") : ("Failed: " + ((iares2 && iares2.error) || "")));
            S.marketplaceItems = buildMarketplaceList();
            if (S.mkCursor >= S.marketplaceItems.length) S.mkCursor = Math.max(0, S.marketplaceItems.length - 1);
            return;
          }
          if (quickItem.seed) {
            installSeedPlugin(quickItem, function() {
              S.marketplaceItems = buildMarketplaceList();
              if (S.mkCursor >= S.marketplaceItems.length) S.mkCursor = Math.max(0, S.marketplaceItems.length - 1);
              render();
            });
            return;
          }
          S.busy = true;
          setBusyMessage("Installing " + (quickItem.name || quickItem.repoName) + "...");
          render();
          marketplaceInstall(quickItem, function(quickErr, quickMethod) {
            S.busy = false;
            if (quickErr) flash(quickErr);
            else { flash("Installed (" + quickMethod + ")! Restart to activate."); S.pluginItems = buildCombinedPluginList(); }
            S.marketplaceItems = buildMarketplaceList();
            if (S.mkCursor >= S.marketplaceItems.length) S.mkCursor = Math.max(0, S.marketplaceItems.length - 1);
            render();
          });
        }
      }
    } else if (S.pluginSubPage === "installed") {
      if (key === "up" || key === "w") { S.pcursor = Math.max(0, S.pcursor - 1); }
      else if (key === "down" || key === "s") { S.pcursor = Math.min(S.pluginItems.length - 1, S.pcursor + 1); }
      else if (key === "enter" || key === "space") {
        if (S.pluginItems.length > 0) {
          var selp = S.pluginItems[S.pcursor];
          // detect a core-plugin once (so getPluginActions can offer "Configure")
          if (selp && selp._cfgProbed !== true) { selp._cfg = probeConfigSchema(selp); selp._cfgProbed = true; }
          S.mode = "pactions"; S.pacursor = 0;
        }
      }
      else if (key === "r") {
        S.pluginItems = buildCombinedPluginList();
        flash("Refreshed.");
      }
      else if (key === "e") {
        S.busy = true;
        setBusyMessage("Updating the updater engine...");
        render();
        updateUpdater(function (ue) {
          // self-update cleared the cached engine module; re-import the (new) one so
          // the TUI doesn't drop to "Updater Plugin Missing" after updating.
          preloadUpdater().catch(function () {}).then(function () {
            S.busy = false;
            S.pluginItems = buildCombinedPluginList();
            flash(ue ? ue : "Updater engine updated.");
            render();
          });
        });
      }
      else if (key === "f") {
        S.busy = true;
        setBusyMessage("Fetching remotes...");
        render();
        fetchPluginRemotes(S.pluginItems, function() {
          S.pluginFetched = true;
          S.busy = false;
          var updateCount = 0;
          for (var p of S.pluginItems) { if (p.updateAvail) updateCount++; }
          flash(updateCount > 0 ? updateCount + " update(s) available" : "All plugins up to date");
          render();
        });
      }
      else if (key === "a") {
        var toUpdate = S.pluginItems.filter(function(p) { return p.type !== "npm" && !p.foreign && p.enabled && (p.updateAvail || !p.deployed); });
        if (toUpdate.length === 0) {
          flash("All plugins are already up to date.");
        } else {
          runUpdateSequence(toUpdate, function() {
            if (S.pcursor >= S.pluginItems.length) S.pcursor = Math.max(0, S.pluginItems.length - 1);
          });
        }
      }
      else if (key === "u") {
        if (S.pluginItems.length > 0 && S.pluginItems[S.pcursor].type !== "npm" && !S.pluginItems[S.pcursor].foreign) {
          var p = S.pluginItems[S.pcursor];
          runUpdateSequence([p], function() {
            if (S.pcursor >= S.pluginItems.length) S.pcursor = Math.max(0, S.pluginItems.length - 1);
          });
        }
      }
      else if (key === "d") {
        if (S.pluginItems.length > 0 && S.pluginItems[S.pcursor].type !== "npm" && !S.pluginItems[S.pcursor].foreign) {
          var p = S.pluginItems[S.pcursor];
          var updater = getUpdater();
          if (updater && updater.disable) {
            updater.disable(p);
          } else {
            // fallback if no updater
            var plugins = loadPlugins();
            var match = plugins.find(function(r) { return r.name === p.name; });
            if (match) { match.enabled = false; savePlugins(plugins); }
            var deployedPath = join(PLUGINS_DIR, (p.pluginFile || p.name + ".js"));
            if (existsSync(deployedPath)) { try { unlinkSync(deployedPath); } catch {} }
          }
          S.pluginItems = buildCombinedPluginList();
          if (S.pcursor >= S.pluginItems.length) S.pcursor = Math.max(0, S.pluginItems.length - 1);
          flash(p.name + " disabled. Restart " + APP_NAME + " to unload.");
        }
      }
    }
  } else if (S.mode === "pactions") {
    var pitem = S.pluginItems[S.pcursor];
    var acts = getPluginActions(pitem);
    if (key === "up" || key === "w") { S.pacursor = Math.max(0, S.pacursor - 1); }
    else if (key === "down" || key === "s") { S.pacursor = Math.min(acts.length - 1, S.pacursor + 1); }
    else if (key === "enter" || key === "space") {
      var action = acts[S.pacursor].key;
      if (action === "update") {
        S.mode = "list";
        runUpdateSequence([pitem], function() {
          if (S.pcursor >= S.pluginItems.length) S.pcursor = Math.max(0, S.pluginItems.length - 1);
        });
      }
      else if (action === "check-updates") {
        S.mode = "list";
        S.busy = true;
        setBusyMessage("Fetching remotes...");
        render();
        fetchPluginRemotes(S.pluginItems, function() {
          S.pluginFetched = true;
          S.busy = false;
          var ucount = 0;
          for (var pu of S.pluginItems) { if (pu.updateAvail) ucount++; }
          flash(ucount > 0 ? ucount + " update(s) available" : "All plugins up to date");
          render();
        });
      }
      else if (action === "update-all") {
        S.mode = "list";
        var toUpdate = S.pluginItems.filter(function(p) { return p.type !== "npm" && p.enabled && (p.updateAvail || !p.deployed); });
        if (toUpdate.length === 0) {
          flash("All plugins are already up to date.");
        } else {
          runUpdateSequence(toUpdate, null);
        }
      }
      else if (action === "refresh") {
        S.pluginItems = buildCombinedPluginList();
        flash("Refreshed.");
        S.mode = "list";
      }
      else if (action === "enable-auto" || action === "disable-auto") {
        var newVal = action === "enable-auto";
        pitem.autoUpdate = newVal;
        var plugins = loadPlugins();
        var match = plugins.find(function(r) { return r.name === pitem.name; });
        if (match) { match.autoUpdate = newVal; savePlugins(plugins); }
        flash(pitem.name + ": auto-update " + (newVal ? "ON" : "OFF"));
        S.mode = "list";
      }
      else if (action === "disable-plugin") {
        var updater = getUpdater();
        if (updater && updater.disable) {
          updater.disable(pitem);
        }
        var plugins = loadPlugins();
        var match = plugins.find(function(r) { return r.name === pitem.name; });
        if (match) { match.enabled = false; } else { plugins.push({ name: pitem.name, enabled: false }); }
        savePlugins(plugins);
        var deployedPath = join(PLUGINS_DIR, (pitem.pluginFile || pitem.name + ".js"));
        if (existsSync(deployedPath)) { try { unlinkSync(deployedPath); } catch {} }
        S.pluginItems = buildCombinedPluginList();
        if (S.pcursor >= S.pluginItems.length) S.pcursor = Math.max(0, S.pluginItems.length - 1);
        flash(pitem.name + " disabled. Restart " + APP_NAME + " to unload.");
        S.mode = "list";
      }
      else if (action === "update-npm") {
        flash("Updating " + pitem.name + "...");
        render();
        var updater = getUpdater();
        var err = "";
        if (updater && typeof updater.updateNpmPlugin === "function") {
          err = updater.updateNpmPlugin(pitem.name, CONFIG_DIR, 0) || "";
        } else {
          try { execSync("npm update -g " + pitem.name, { timeout: 60000, stdio: "ignore" }); }
          catch(e) { err = e.message; }
        }
        S.pluginItems = buildCombinedPluginList();
        if (S.pcursor >= S.pluginItems.length) S.pcursor = Math.max(0, S.pluginItems.length - 1);
        if (!err) reportPluginAction("updated", pitem.name, { kind: "npm", message: "Updated " + pitem.name });
        flash(err ? pitem.name + ": " + err : pitem.name + " updated. Restart " + APP_NAME + " to apply.");
        S.mode = "list";
      }
      else if (action === "uninstall-npm") {
        S.confirmAction = { type: "uninstall-npm", target: pitem };
        S.confirmLabel = "Uninstall npm plugin " + pitem.name + "? It is removed from opencode.json.";
        S.confirmCursor = 0;
        S.mode = "confirm";
      }
      else if (action === "uninstall-plugin") {
        S.confirmAction = { type: "uninstall-plugin", target: pitem };
        S.confirmLabel = "Uninstall " + pitem.name + "? This deletes its repo clone.";
        S.confirmCursor = 0;
        S.mode = "confirm";
      }
            else if (action === "enable-plugin") {
        var plugins = loadPlugins();
        var match = plugins.find(function(r) { return r.name === pitem.name; });
        if (match) { delete match.enabled; } else { plugins.push({ name: pitem.name }); }
        savePlugins(plugins);
        flash("Setting up " + pitem.name + "...");
        S.mode = "list";
        render();
        setupPlugin(match || { name: pitem.name, url: pitem.url }, function(setupErr) {
          S.pluginItems = buildCombinedPluginList();
          if (S.pcursor >= S.pluginItems.length) S.pcursor = Math.max(0, S.pluginItems.length - 1);
          flash(setupErr ? pitem.name + ": " + setupErr : pitem.name + " enabled and deployed. Restart " + APP_NAME + " to load.");
          render();
        });
      }
      else if (action === "configure") {
        var cfg = pitem._cfg;
        if (cfg && cfg.items && cfg.items.length) {
          S.configTarget = cfg;
          S.configItems = cfg.items;
          S.cfgcursor = 0; S.cfgScrollOff = 0;
          S.mode = "pconfig";
        } else {
          flash("No configurable settings."); S.mode = "list";
        }
      }
      else if (action === "commits") {
        var dir = join(REPOS_DIR, pitem.folderName);
        if (!existsSync(dir)) { flash("Not installed locally yet"); S.mode = "list"; return; }
        try {
          var log = execSync('git log -20 --format="%h|%s|%ar"', { cwd: dir, encoding: "utf-8", timeout: 5000 });
          var lines = log.trim().split("\n");
          S.commitItems = [];
          for (var i = 0; i < lines.length; i++) {
            if (!lines[i]) continue;
            var parts = lines[i].split("|");
            if (parts.length >= 3) {
              S.commitItems.push({ hash: parts[0], subject: parts.slice(1, -1).join("|"), time: parts[parts.length-1] });
            }
          }
          if (S.commitItems.length > 0) {
            S.ccursor = 0; S.cscrollOff = 0; S.mode = "pcommits";
          } else {
            flash("No commits found"); S.mode = "list";
          }
        } catch (e) {
          flash("Failed to fetch commits"); S.mode = "list";
        }
      }
      else if (action === "foreign-toggle") {
        S.mode = "list";
        var newEnabled = !pitem.enabled;
        var toggleFn = S.capabilities && S.capabilities.setForeignPluginEnabled;
        var tres = typeof toggleFn === "function" ? toggleFn(pitem.key, newEnabled) : { ok: false, error: "not available" };
        S.pluginItems = buildCombinedPluginList();
        if (S.pcursor >= S.pluginItems.length) S.pcursor = Math.max(0, S.pluginItems.length - 1);
        flash(tres && tres.ok ? (pitem.name + (newEnabled ? " enabled." : " disabled.")) : ("Failed: " + ((tres && tres.error) || "unknown error")));
      }
      else if (action === "foreign-uninstall") {
        S.confirmAction = { type: "uninstall-foreign", target: pitem };
        S.confirmLabel = "Uninstall " + pitem.name + "? This removes it via " + APP_NAME + ".";
        S.confirmCursor = 0;
        S.mode = "confirm";
      }
      else { S.mode = "list"; }
    }
    else if (key === "escape" || key === "q" || key === "left") { S.mode = "list"; }
  } else if (S.mode === "pconfig") {
    var citem = S.configItems[S.cfgcursor];
    if (key === "up" || key === "w") { S.cfgcursor = Math.max(0, S.cfgcursor - 1); }
    else if (key === "down" || key === "s") { S.cfgcursor = Math.min(S.configItems.length - 1, S.cfgcursor + 1); }
    else if (key === "escape" || key === "q" || key === "left") { S.mode = "pactions"; }
    else if ((key === "enter" || key === "space") && citem) { activateConfigItem(citem, "pcfginput"); }
  } else if (S.mode === "confirm") {
    if (key === "y") {
      if (S.confirmAction && S.confirmAction.type === "uninstall-plugin") {
        var cpitem = S.confirmAction.target;
        var updater = getUpdater();
        if (updater && updater.uninstall) {
          updater.uninstall(cpitem);
        } else {
          var cdir = join(REPOS_DIR, cpitem.folderName);
          var cdeployed = join(PLUGINS_DIR, (cpitem.pluginFile || cpitem.name + ".js"));
          if (existsSync(cdir)) { try { var rmS = require("fs").rmSync; if (rmS) rmS(cdir, {recursive:true,force:true}); } catch(e){} }
          if (existsSync(cdeployed)) { try { unlinkSync(cdeployed); } catch(e){} }
        }
        var cplugins = loadPlugins();
        cplugins = cplugins.filter(function(r) { return r.name !== cpitem.name; });
        savePlugins(cplugins);
        S.pluginItems = buildCombinedPluginList();
        if (S.pcursor >= S.pluginItems.length) S.pcursor = Math.max(0, S.pluginItems.length - 1);
        reportPluginAction("uninstalled", cpitem.name, { kind: "git", message: "Uninstalled " + cpitem.name });
        flash(cpitem.name + " uninstalled.");
      } else if (S.confirmAction && S.confirmAction.type === "uninstall-npm") {
        var cpitem = S.confirmAction.target;
        try {
          var updater = getUpdater();
          if (updater && typeof updater.uninstallNpmPlugin === "function") {
            updater.uninstallNpmPlugin(cpitem.name, CONFIG_DIR);
          } else {
            execSync("npm uninstall -g " + cpitem.name, { timeout: 60000, stdio: "ignore" });
            var cplugins = loadPlugins();
            cplugins = cplugins.filter(function(r) { return r.name !== cpitem.name; });
            savePlugins(cplugins);
          }
          S.pluginItems = buildCombinedPluginList();
          if (S.pcursor >= S.pluginItems.length) S.pcursor = Math.max(0, S.pluginItems.length - 1);
          reportPluginAction("uninstalled", cpitem.name, { kind: "npm", message: "Uninstalled " + cpitem.name });
          flash(cpitem.name + " uninstalled. Restart " + APP_NAME + ".");
        } catch(e) {
          flash("Uninstall failed. Try: npm uninstall -g " + cpitem.name);
        }
      }
    } else {
      flash("Cancelled.");
    }
    S.mode = "list";
    S.confirmAction = null;
  } else if (S.mode === "pcommits") {
    if (key === "up" || key === "w") { S.ccursor = Math.max(0, S.ccursor - 1); }
    else if (key === "down" || key === "s") { S.ccursor = Math.min(S.commitItems.length - 1, S.ccursor + 1); }
    else if (key === "escape" || key === "q" || key === "left") { S.mode = "list"; }
    else if (key === "enter" || key === "space") {
      var pitem = S.pluginItems[S.pcursor];
      var citem = S.commitItems[S.ccursor];
      flash("Downgrading " + pitem.name + " to " + citem.hash + "...");
      render();
      
      var err = "";
      var updater = getUpdater();
      // Prefer the updater's downgrade() when the deployed bundle actually exposes
      // it; otherwise (older updater without the method) check the commit out
      // directly in the repo clone. Guarding the typeof avoids a crash when it's absent.
      if (updater && typeof updater.downgrade === "function") {
        var plugins = loadPlugins();
        var repo = plugins.find(function(r) { return r.name === pitem.name; });
        err = repo ? updater.downgrade(repo, citem.hash) : "plugin not found";
      } else {
        var dir = join(REPOS_DIR, pitem.folderName);
        try {
          execSync("git reset --hard", { cwd: dir, timeout: 15000, stdio: "ignore" });
          execSync("git checkout " + citem.hash, { cwd: dir, timeout: 15000, stdio: "ignore" });
        } catch (e) {
          flash("Checkout failed"); S.mode = "list"; return;
        }
        // only this branch is our own work: updater.downgrade() reports itself
        reportPluginAction("downgraded", pitem.name, { hash: citem.hash, message: "Downgraded " + pitem.name + " to " + citem.hash });
      }
      if (err === "Success" || !err) err = "";
      
      S.pluginItems = buildCombinedPluginList();
      flash(err ? pitem.name + ": " + err : pitem.name + " downgraded. Restart " + APP_NAME + " to apply.");
      S.mode = "list";
    }
  }
}

export function handleInputData(buf) {
  if (buf[0] === 27) { S.mode = "list"; S.chpathDir = ""; return; }
  if (buf[0] === 3) { cleanup(); process.exit(1); }
  if (buf[0] === 13 || buf[0] === 10) {
    var p = S.inputBuf.trim();
    if (p) {
      if (p.charAt(0) === "~") p = HOME + p.substring(1);
      p = p.replace(/\//g, "\\");
      if (S.chpathDir) {
        if (p === S.chpathDir) { flash("Same path, nothing changed"); S.mode = "list"; S.chpathDir = ""; return; }
        if (existsSync(p)) {
          changeProjectPath(S.chpathDir, p);
        } else {
          flash("Path not found: " + p);
        }
        S.mode = "list"; S.chpathDir = "";
      } else {
        if (existsSync(p)) {
          cleanup();
          outputDir(p);
          process.exit(0);
        } else {
          flash("Path not found: " + p);
          S.mode = "list";
        }
      }
    } else {
      S.mode = "list"; S.chpathDir = "";
    }
    return;
  }
  if (buf[0] === 127 || buf[0] === 8) {
    S.inputBuf = S.inputBuf.substring(0, S.inputBuf.length - 1);
    return;
  }
  if (buf[0] >= 32 && buf[0] < 127) {
    S.inputBuf += String.fromCharCode(buf[0]);
    return;
  }
  var s = buf.toString("utf-8");
  if (s.length > 0) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 32) S.inputBuf += s.charAt(i);
    }
  }
}

export function parseKey(buf) {
  if (buf[0] === 27) {
    if (buf.length === 1) return "escape";
    if (buf[1] === 91) {
      if (buf[2] === 65) return "up";
      if (buf[2] === 66) return "down";
      if (buf[2] === 67) return "right";
      if (buf[2] === 68) return "left";
    }
    return null;
  }
  if (buf[0] === 13 || buf[0] === 10) return "enter";
  if (buf[0] === 32) return "space";
  if (buf[0] === 3) { cleanup(); process.exit(1); }
  if (buf[0] === 9) return "tab";
  var ch = String.fromCharCode(buf[0]).toLowerCase();
  // NB: every actionable letter key MUST be listed here or parseKey drops it before
  // any handler ever sees it.
  if ("wsadqpchofuximynreg/?[]".indexOf(ch) !== -1) return ch;
  return null;
}

export function handleConfirmKey(key) {
  if (key === "up" || key === "w") { S.confirmCursor = 0; return; }
  if (key === "down" || key === "s") { S.confirmCursor = 1; return; }
  var accepted = key === "y" || ((key === "enter" || key === "space") && S.confirmCursor === 0);
  var rejected = key === "escape" || key === "q" || key === "n" || ((key === "enter" || key === "space") && S.confirmCursor === 1);
  if (accepted) {
    if (S.confirmAction && S.confirmAction.type === "uninstall-plugin") {
      var pitem = S.confirmAction.target;
      var plugins = loadPlugins();
      plugins = plugins.filter(function(r) { return r.name !== pitem.name; });
      savePlugins(plugins);
      var deployedPath = join(PLUGINS_DIR, (pitem.pluginFile || pitem.name + ".js"));
      if (existsSync(deployedPath)) { try { unlinkSync(deployedPath); } catch {} }
      var repoDir = join(REPOS_DIR, pitem.folderName);
      if (existsSync(repoDir)) {
        try { execSync((process.platform === "win32" ? "rmdir /s /q " : "rm -rf ") + '"' + repoDir + '"', { timeout: 30000, stdio: "ignore" }); } catch {}
      }
      S.pluginItems = buildCombinedPluginList();
      if (S.pcursor >= S.pluginItems.length) S.pcursor = Math.max(0, S.pluginItems.length - 1);
      reportPluginAction("uninstalled", pitem.name, { kind: "git", message: "Uninstalled " + pitem.name });
      flash(pitem.name + " uninstalled.");
    } else if (S.confirmAction && S.confirmAction.type === "uninstall-npm") {
      var npmName = S.confirmAction.target.name || S.confirmAction.target;
      var npmUpdater = getUpdater();
      var npmErr = "updater not available";
      if (npmUpdater && typeof npmUpdater.uninstallNpmPlugin === "function") {
        npmErr = npmUpdater.uninstallNpmPlugin(npmName, CONFIG_DIR) || "";
      }
      S.pluginItems = buildCombinedPluginList();
      if (S.pcursor >= S.pluginItems.length) S.pcursor = Math.max(0, S.pluginItems.length - 1);
      if (!npmErr) reportPluginAction("uninstalled", npmName, { kind: "npm", message: "Uninstalled " + npmName });
      flash(npmErr ? npmName + ": " + npmErr : npmName + " removed from opencode.json. Restart " + APP_NAME + " to unload.");
    } else if (S.confirmAction && S.confirmAction.type === "uninstall-mcp") {
      uninstallMcpServer(S.confirmAction.target);
      S.mcpItems = buildMcpList("All");
      if (S.mcpCursor >= S.mcpItems.length) S.mcpCursor = Math.max(0, S.mcpItems.length - 1);
      flash(S.confirmAction.target + " removed.");
    } else if (S.confirmAction && S.confirmAction.type === "uninstall-foreign") {
      var fpitem = S.confirmAction.target;
      var uninstallFn = S.capabilities && S.capabilities.uninstallForeignPlugin;
      var ures = typeof uninstallFn === "function" ? uninstallFn(fpitem.key) : { ok: false, error: "not available" };
      S.pluginItems = buildCombinedPluginList();
      if (S.pcursor >= S.pluginItems.length) S.pcursor = Math.max(0, S.pluginItems.length - 1);
      flash(ures && ures.ok ? (fpitem.name + " uninstalled.") : ("Failed: " + ((ures && ures.error) || "unknown error")));
    }
    S.confirmAction = null;
    S.confirmLabel = "";
    S.confirmCursor = 0;
    S.mode = "list";
  } else if (rejected) {
    S.confirmAction = null;
    S.confirmLabel = "";
    S.confirmCursor = 0;
    S.mode = "list";
    flash("Cancelled.");
  }
}

// Run a config-ledger action chosen from the git action menu (sgmenu) or, when the
// repo isn't set up yet, the "press g to set up" shortcut in list mode. Always
// leaves S.mode in a valid state (list, or sgdiff for the review screen) so a
// caller never has to clean up after it.
function runGitMenuAction(action) {
  var m = getConfigLedger();
  if (!m) { flash("config-ledger not installed."); S.mode = "list"; return; }
  if (action === "commit") {
    try { var made = m.autoCommit("manual"); flash(made ? "Committed." : "Nothing to commit."); }
    catch (e) { flash("Commit failed: " + ((e && e.message) || e)); }
    refreshVersioning(); S.mode = "list"; return;
  }
  if (action === "diff") {
    try { S.clDiffRows = m.diffAgainstHead() || []; } catch { S.clDiffRows = []; }
    S.mode = "sgdiff"; return;
  }
  if (action === "push") {
    flash("Pushing...");
    try { var pr = m.repo.push(); flash(pr && pr.message ? pr.message : (pr && pr.ok ? "Pushed." : "Push failed.")); }
    catch (e) { flash("Push failed: " + ((e && e.message) || e)); }
    S.mode = "list"; return;
  }
  if (action === "pull") {
    flash("Pulling...");
    try { var lr = m.repo.pull(); flash(lr && lr.message ? lr.message : (lr && lr.ok ? "Pulled." : "Pull failed.")); }
    catch (e) { flash("Pull failed: " + ((e && e.message) || e)); }
    refreshVersioning(); S.mode = "list"; return;
  }
  if (action === "history") { openHistoryPicker(); return; }
  if (action === "profiles") { openProfiles(); return; }
  if (action === "setup") { S.mode = "sgsetup"; S.sgSetupCursor = 0; return; }
  flash("Unknown git action."); S.mode = "list";
}

// History flow (Versioning tab): pick a config file → pick a key → its value timeline.
// Sections (file + keys) come from the same builders the Settings tab uses.
function openHistoryPicker() {
  var secs = [buildGlobalSection()];
  var plugins = (S.pluginItems && S.pluginItems.length) ? S.pluginItems : [];
  for (var s of buildPluginSections(plugins)) secs.push(s);
  S.vgSections = secs; S.vgFileCursor = 0; S.mode = "vghfiles";
}

// Snapshot profiles.list()/current() into state and enter the picker (also used
// by the "g" setup-not-ready shortcut and the "p" list-mode key below).
function openProfiles() {
  var m = getConfigLedger();
  if (!m) { flash("config-ledger not installed."); return; }
  try { S.clProfiles = m.profiles.list() || []; } catch { S.clProfiles = []; }
  try { S.clProfileCurrent = m.profiles.current() || ""; } catch { S.clProfileCurrent = ""; }
  S.clProfileCursor = Math.max(0, S.clProfiles.indexOf(S.clProfileCurrent));
  S.mode = "sgprofiles";
}

// Repo-setup actions (S.mode === "sgsetup"): initialize+seed, open the remote-URL
// input, or create a private GitHub repo via `gh` and set it as the remote.
function runSetupAction(action) {
  var m = getConfigLedger();
  if (!m) { flash("config-ledger not installed."); S.mode = "list"; return; }
  // Fresh-repo buttons (2): local-only, or initialize + connect a remote.
  if (action === "init-local") {
    try { m.setup.initAndSeed(); flash("Local repo initialized + seeded."); }
    catch (e) { flash("Init failed: " + ((e && e.message) || e)); }
    S.versioningCursor = 0; refreshVersioning(); S.mode = "list"; return;
  }
  if (action === "init-remote") {
    try { m.setup.initAndSeed(); }
    catch (e) { flash("Init failed: " + ((e && e.message) || e)); refreshVersioning(); S.mode = "list"; return; }
    var gh = false; try { gh = m.setup.ghAvailable(); } catch {}
    if (gh) {
      try {
        var gr = m.setup.ghCreatePrivate("config-ledger-" + (process.env.HUB_APP || "loader"));
        flash(gr && gr.ok ? ("Created + connected: " + gr.url) : ("gh failed: " + (gr && gr.message)));
      } catch (e) { flash("gh failed: " + ((e && e.message) || e)); }
      S.versioningCursor = 0; refreshVersioning(); S.mode = "list";
    } else {
      S.inputBuf = ""; S.mode = "sgurlinput";   // no gh → paste a remote URL
    }
    return;
  }
  if (action === "init") {   // (still reachable from the managed "Repo setup" sub-menu as "Re-seed")
    try { m.setup.initAndSeed(); flash("Repo re-seeded."); }
    catch (e) { flash("Re-seed failed: " + ((e && e.message) || e)); }
    S.versioningCursor = 0; refreshVersioning(); S.mode = "list"; return;
  }
  if (action === "remote") { S.inputBuf = ""; S.mode = "sgurlinput"; return; }
  if (action === "gh") {
    try {
      var r = m.setup.ghCreatePrivate("config-ledger-" + (process.env.HUB_APP || "loader"));
      flash(r && r.ok ? ("Created + set remote: " + r.url) : ("gh failed: " + (r && r.message)));
    } catch (e) { flash("gh failed: " + ((e && e.message) || e)); }
    refreshVersioning(); S.mode = "list"; return;
  }
  flash("Unknown setup action."); S.mode = "list";
}

export function handleSettingsKey(key) {
  // The Settings tab has two sub-tabs (Tab switches). Versioning owns all of its own keys.
  if ((S.settingsSubPage || "settings") === "versioning") {
    if (key === "tab" && S.mode === "list") { S.settingsSubPage = "settings"; S.mode = "list"; refreshSettings(); return; }
    handleVersioningKey(key);
    return;
  }

  if (S.mode === "pconfig" || S.mode === "pcfginput") {
    // Shared config editor: cursor nav + boolean toggle / open text input.
    // pcfginput text is captured by handleConfigInputData in the onData router.
    var citem = S.configItems[S.cfgcursor];
    if (key === "up" || key === "w") { S.cfgcursor = Math.max(0, S.cfgcursor - 1); }
    else if (key === "down" || key === "s") { S.cfgcursor = Math.min(S.configItems.length - 1, S.cfgcursor + 1); }
    else if (key === "escape" || key === "q" || key === "left") { S.mode = "list"; }
    else if ((key === "enter" || key === "space") && citem) { activateConfigItem(citem, "pcfginput"); }
    return;
  }

  // Tab → Versioning sub-tab (and re-detect config-ledger, in case it was just installed).
  if (key === "tab" && S.mode === "list") { S.settingsSubPage = "versioning"; S.mode = "list"; S.versioningCursor = 0; try { reconcileConfigLedger(); } catch (e) {} return; }

  // list mode: "Global"/"Plugins" grouped list (nav skips headers). Enter drills into a
  // group's editor. Versioning/git lives in the Versioning sub-tab.
  if (key === "q" || key === "escape") { cleanup(); process.exit(1); return; }
  if (!S.settingsEntries || !S.settingsEntries.length) refreshSettings();

  function stepEntry(dir) {
    var n = S.settingsEntries.length;
    var i = S.settingsCursor;
    for (var step = 0; step < n; step++) {
      i += dir;
      if (i < 0 || i >= n) return;                        // clamp at ends
      if (S.settingsEntries[i] && S.settingsEntries[i].type === "group") { S.settingsCursor = i; return; }
    }
  }
  if (key === "up" || key === "w") { stepEntry(-1); return; }
  if (key === "down" || key === "s") { stepEntry(1); return; }

  if (key === "enter" || key === "space") {
    var en = S.settingsEntries[S.settingsCursor];
    if (!en || en.type !== "group") return;
    var sec = en.section;
    S.configTarget = (sec.kind === "global")
      ? { name: "settings", global: true, file: sec.file, items: sec.items }
      : { name: sec.label, bundle: sec.bundle, file: sec.file, items: sec.items };
    S.configItems = sec.items;
    S.cfgcursor = 0;
    S.cfgScrollOff = 0;
    S.mode = "pconfig";
    return;
  }
}

// The Versioning tab (config-ledger git UI). Sub-screens are keyed by S.mode; the default
// ("list") shows the install gate / setup menu / actions home depending on plugin state.
export function handleVersioningKey(key) {
  if (S.mode === "sgdiff") {
    if (key === "escape" || key === "q" || key === "left") { S.mode = "list"; return; }
    if (key === "c") { runGitMenuAction("commit"); return; }
    if (key === "i") {
      var im = getConfigLedger();
      if (!im) { flash("config-ledger not installed."); S.mode = "list"; return; }
      try { var n = im.importFromHead(); flash("Imported " + n + " file(s) from repo (restart to apply)"); }
      catch (e) { flash("Import failed: " + ((e && e.message) || e)); }
      refreshVersioning(); S.mode = "list"; return;
    }
    return;
  }
  if (S.mode === "vghfiles") {
    var fsecs = S.vgSections || [];
    if (key === "escape" || key === "q" || key === "left") { S.mode = "list"; return; }
    if (key === "up" || key === "w") { S.vgFileCursor = Math.max(0, S.vgFileCursor - 1); return; }
    if (key === "down" || key === "s") { S.vgFileCursor = Math.min((fsecs.length || 1) - 1, S.vgFileCursor + 1); return; }
    if ((key === "enter" || key === "space") && fsecs[S.vgFileCursor]) {
      var fsec = fsecs[S.vgFileCursor];
      S.vgHistFile = fsec.file;
      S.vgKeys = (fsec.items || []).map(function (it) { return it.key; });
      S.vgKeyCursor = 0;
      S.mode = "vghkeys";
    }
    return;
  }
  if (S.mode === "vghkeys") {
    var vkeys = S.vgKeys || [];
    if (key === "escape" || key === "q" || key === "left") { S.mode = "vghfiles"; return; }
    if (key === "up" || key === "w") { S.vgKeyCursor = Math.max(0, S.vgKeyCursor - 1); return; }
    if (key === "down" || key === "s") { S.vgKeyCursor = Math.min((vkeys.length || 1) - 1, S.vgKeyCursor + 1); return; }
    if ((key === "enter" || key === "space") && vkeys[S.vgKeyCursor]) {
      var khm = getConfigLedger();
      S.clHistoryFile = S.vgHistFile;
      S.clHistoryKey = vkeys[S.vgKeyCursor];
      try { S.clHistory = khm.keyHistory(S.vgHistFile, vkeys[S.vgKeyCursor]) || []; } catch { S.clHistory = []; }
      S.clHistoryCursor = 0;
      S.mode = "sghistory";
    }
    return;
  }
  if (S.mode === "sghistory") {
    if (key === "escape" || key === "q" || key === "left") { S.mode = "vghkeys"; return; }
    if (key === "up" || key === "w") { S.clHistoryCursor = Math.max(0, S.clHistoryCursor - 1); return; }
    if (key === "down" || key === "s") { S.clHistoryCursor = Math.min((S.clHistory.length || 1) - 1, S.clHistoryCursor + 1); return; }
    if ((key === "enter" || key === "space") && S.clHistory[S.clHistoryCursor]) {
      var hh = S.clHistory[S.clHistoryCursor];
      var rm = getConfigLedger();
      try { rm.rollbackKey(S.clHistoryFile, S.clHistoryKey, hh.hash); flash("Rolled back " + S.clHistoryKey + " to " + String(hh.hash).slice(0, 7)); }
      catch (e) { flash("Rollback failed: " + ((e && e.message) || e)); }
      refreshVersioning(); S.mode = "list"; return;
    }
    return;
  }
  if (S.mode === "sgprofiles") {
    if (key === "escape" || key === "q" || key === "left") { S.mode = "list"; return; }
    if (key === "up" || key === "w") { S.clProfileCursor = Math.max(0, S.clProfileCursor - 1); return; }
    if (key === "down" || key === "s") { S.clProfileCursor = Math.min((S.clProfiles.length || 1) - 1, S.clProfileCursor + 1); return; }
    if (key === "n") { S.inputBuf = ""; S.mode = "sgprofinput"; return; }
    if ((key === "enter" || key === "space") && S.clProfiles[S.clProfileCursor]) {
      var pm = getConfigLedger();
      try { pm.profiles.switchTo(S.clProfiles[S.clProfileCursor]); } catch (e) { flash("Switch failed: " + ((e && e.message) || e)); S.mode = "list"; return; }
      try { S.clDiffRows = pm.diffAgainstHead() || []; } catch { S.clDiffRows = []; }
      flash("Switched to " + S.clProfiles[S.clProfileCursor] + " -- review from the diff screen");
      S.mode = "sgdiff"; return;
    }
    return;
  }
  if (S.mode === "sgsetup") {
    var setupOpts = S._sgSetupOpts || [];
    if (key === "escape" || key === "q" || key === "left") { S.mode = "list"; return; }
    if (key === "up" || key === "w") { S.sgSetupCursor = Math.max(0, S.sgSetupCursor - 1); return; }
    if (key === "down" || key === "s") { S.sgSetupCursor = Math.min(setupOpts.length - 1, S.sgSetupCursor + 1); return; }
    if (key === "enter" || key === "space") { runSetupAction(setupOpts[S.sgSetupCursor] && setupOpts[S.sgSetupCursor].key); return; }
    return;
  }

  // default view (S.mode "list"): gate / setup / home, by config-ledger state
  if (key === "q" || key === "escape") { cleanup(); process.exit(1); return; }

  if (!configLedgerInstalled()) {
    if (key === "enter" || key === "space") { installConfigLedger(); }   // one Enter installs (updater first if needed)
    return;
  }
  if (!configLedgerReady()) {
    if (key === "up" || key === "w") { S.versioningCursor = Math.max(0, S.versioningCursor - 1); return; }
    if (key === "down" || key === "s") { S.versioningCursor = Math.min(VG_INIT_OPTS.length - 1, S.versioningCursor + 1); return; }
    if (key === "enter" || key === "space") { runSetupAction(VG_INIT_OPTS[S.versioningCursor] && VG_INIT_OPTS[S.versioningCursor].key); return; }
    return;
  }
  // ready → actions home
  var items = VG_MENU_ITEMS;
  if (key === "up" || key === "w") { S.versioningCursor = Math.max(0, S.versioningCursor - 1); return; }
  if (key === "down" || key === "s") { S.versioningCursor = Math.min(items.length - 1, S.versioningCursor + 1); return; }
  if (key === "enter" || key === "space") { runGitMenuAction(items[S.versioningCursor].key); return; }
}

// Install config-ledger on demand from the Settings tab (non-blocking: the tab stays
// usable without it). Uses the same marketplace install path as the Plugins tab, then
// re-imports the freshly cloned lib so git features light up without a restart.
function installConfigLedger() {
  var entry = (OFFICIAL_PLUGINS || []).find(function (p) { return p.name === "config-ledger"; });
  if (!entry) { flash("config-ledger not found in the official catalog."); return; }
  // plugin-updater is the engine that installs & manages every git plugin; it is a
  // prerequisite. Install it first (if not already) with the same step-checklist screen
  // the Plugins tab uses, then continue to config-ledger. One Enter does both.
  var upd = getUpdater();
  if (upd && typeof upd.updatePluginPublic === "function") { doInstallConfigLedger(entry); return; }
  S.updaterInstalling = true; S.updaterSteps = []; render();
  var uerr = installUpdater(CONFIG_DIR, APP_NAME, function (label) { S.updaterSteps.push(label); render(); });
  S.updaterInstalling = false;
  clearUpdaterCache();   // installUpdater ran the engine; re-import it so getUpdater() sees it
  if (uerr) { flash(uerr); render(); return; }
  preloadUpdater().catch(function () {}).then(function () { S.hasUpdater = false; doInstallConfigLedger(entry); });
}

function doInstallConfigLedger(entry) {
  S.busy = true;
  S.clInstalling = true;               // Versioning shows a spinner progress screen while this runs
  setBusyMessage("Installing config-ledger... (clone + build)");
  render();
  marketplaceInstall({ name: entry.name, repoName: entry.repoName, url: entry.url, install: "git" }, function (err) {
    S.busy = false;
    S.clInstalling = false;
    if (err) { flash(err); render(); return; }
    preloadConfigLedger().catch(function () {}).then(function () {
      try { S.pluginItems = buildCombinedPluginList(); } catch (e) {}
      refreshSettings();               // config-ledger now appears as a plugin in Settings
      S.versioningCursor = 0; refreshVersioning();   // Versioning tab flips to the setup screen
      flash(configLedgerInstalled() ? "config-ledger installed! Set up the repo below." : "Installed — restart to activate.");
      render();
    });
  }, "git");
}

export function handleMcpKey(key) {
  if (S.mcpMode === "catalog") {
    if (key === "tab") {
      S.inputBuf = "";
      if (S.mcpSubPage === "installed") { S.mcpSubPage = "marketplace"; S.mcpItems = buildMcpList("All"); S.mcpCursor = 0; }
      else { S.mcpSubPage = "installed"; S.mcpCursor = 0; }
      S.mcpScrollOff = 0;
    }
    else if (key === "up" || key === "w") { S.mcpCursor = Math.max(0, S.mcpCursor - 1); }
    else if (key === "down" || key === "s") {
      var maxLen = S.mcpSubPage === "installed" ? buildInstalledMcpRows().length : S.mcpItems.length;
      S.mcpCursor = Math.min(maxLen - 1, S.mcpCursor + 1);
    }
    else if (key === "enter" || key === "space") {
      if (S.mcpSubPage === "installed") {
        var instRow = buildInstalledMcpRows()[S.mcpCursor];
        if (!instRow) return;
        if (instRow.isAction) {
          if (instRow.actionKey === "add_mcp_server") {
            S.mcpAddDraft = { name: "", transport: "http", target: "" };
            S.mcpAddStep = 0;
            S.inputBuf = "";
            S.mode = "mcpaddinput";
          }
          return;
        }
        // capability-sourced servers have no per-item action menu yet (no
        // remove/configure capability defined); only the legacy on-disk list does.
        if (instRow.fromCapability) return;
        S.mcpMode = "actions"; S.mcpAcursor = 0;
        return;
      }
      if (S.mcpItems.length > 0) { S.mcpMode = "actions"; S.mcpAcursor = 0; }
    }
    else if (key === "/" && S.mcpSubPage === "marketplace") { S.mode = "search"; return; }
    else if (key === "i" && S.mcpSubPage === "marketplace") {
      if (S.mcpItems.length > 0 && !S.mcpItems[S.mcpCursor].installed) {
        installMcpServer(S.mcpItems[S.mcpCursor]);
        S.mcpItems = buildMcpList("All");
        flash(S.mcpItems[S.mcpCursor] ? S.mcpItems[S.mcpCursor].name + " installed. Restart " + APP_NAME + " to activate." : "Installed.");
      }
    }
    else if (key === "x" && S.mcpSubPage === "installed") {
      var instList = buildInstalledMcpRows();
      var instTarget = instList[S.mcpCursor];
      if (instTarget && !instTarget.isAction && !instTarget.fromCapability) {
        S.confirmAction = { type: "uninstall-mcp", target: instTarget.name };
        S.confirmLabel = "Remove MCP server " + instTarget.name + "?";
        S.confirmCursor = 0;
        S.mode = "confirm";
      }
    }
    else if (key === "r") {
      invalidateCatalogCache();
      S.catalogFetched = false;
      S.mcpItems = buildMcpList("All");
      flash("Refreshing catalog...");
    }
    else if (key === "q" || key === "escape") { cleanup(); process.exit(1); }
  } else if (S.mcpMode === "actions") {
    var activeList = S.mcpSubPage === "installed" ? buildInstalledMcpRows() : S.mcpItems;
    var mitem = activeList[S.mcpCursor];
    if (!mitem) { S.mcpMode = "catalog"; return; }
    var acts = getMcpActions(mitem);
    if (key === "up" || key === "w") { S.mcpAcursor = Math.max(0, S.mcpAcursor - 1); }
    else if (key === "down" || key === "s") { S.mcpAcursor = Math.min(acts.length - 1, S.mcpAcursor + 1); }
    else if (key === "enter" || key === "space") {
      var action = acts[S.mcpAcursor].key;
      if (action === "install") {
        installMcpServer(mitem);
        S.mcpItems = buildMcpList("All");
        flash(mitem.name + " installed. Restart " + APP_NAME + " to activate.");
        S.mcpMode = "catalog";
      } else if (action === "uninstall") {
        S.confirmAction = { type: "uninstall-mcp", target: mitem.name };
        S.confirmLabel = "Remove MCP server " + mitem.name + "?";
        S.confirmCursor = 0;
        S.mode = "confirm";
        S.mcpMode = "catalog";
      } else if (action === "configure") {
        flash("Set env vars in " + MCP_CONFIG_PATH);
        S.mcpMode = "catalog";
      } else if (action === "browser") {
        var npmPkg = (mitem.args || []).find(function(arg) { return arg.indexOf("@") !== -1 && arg !== "-y"; });
        if (npmPkg) {
          var pkgName = npmPkg.replace(/@latest$/, "").replace(/@\^.*$/, "");
          var npmUrl = "https://www.npmjs.com/package/" + pkgName;
          try {
            var openCmd = process.platform === "win32" ? "start \"\" \"" + npmUrl + "\"" : process.platform === "darwin" ? "open \"" + npmUrl + "\"" : "xdg-open \"" + npmUrl + "\"";
            execSync(openCmd, { timeout: 5000, stdio: "ignore" });
            flash("Opened in browser");
          } catch(e) { flash("No browser available: " + npmUrl); }
        }
        S.mcpMode = "catalog";
      } else {
        S.mcpMode = "catalog";
      }
    }
    else if (key === "escape" || key === "left") { S.mcpMode = "catalog"; }
  }
}

// Read-only: no per-row action menu, just cursor movement and a manual refresh.
export function handleActivityKey(key) {
  if (key === "up" || key === "w") { S.activityCursor = Math.max(0, S.activityCursor - 1); }
  else if (key === "down" || key === "s") {
    S.activityCursor = Math.min(Math.max(0, (S.activityRecords || []).length - 1), S.activityCursor + 1);
  }
  else if (key === "r") {
    S.activityRecords = readActivityRecords();
    S.activityCursor = 0;
    S.activityScrollOff = 0;
    flash("Refreshed.");
  }
  else if (key === "i") {
    cycleImpactFilter();
    S.activityRecords = readActivityRecords();
    S.activityCursor = 0;
    S.activityScrollOff = 0;
    var active = S.activityImpacts.length ? S.activityImpacts.join(", ") : "all impacts";
    flash("Showing " + active + ".");
  }
  else if (key === "q" || key === "escape") { cleanup(); process.exit(1); }
}

export function handleSearchData(buf) {
  if (buf[0] === 27) { S.mode = "list"; return; }
  if (buf[0] === 3) { cleanup(); process.exit(1); }
  if (buf[0] === 13 || buf[0] === 10) { S.mode = "list"; return; }
  if (buf[0] === 8 || buf[0] === 127) {
    S.inputBuf = S.inputBuf.slice(0, -1);
    if (S.page === "plugins") { S.marketplaceItems = buildMarketplaceList(); S.mkCursor = 0; }
    else if (S.page === "mcp") { S.mcpItems = buildMcpList("All"); S.mcpCursor = 0; }
    return;
  }
  var ch = String.fromCharCode(buf[0]);
  if (buf[0] >= 32 && buf[0] <= 126) {
    S.inputBuf += ch;
    if (S.page === "plugins") { S.marketplaceItems = buildMarketplaceList(); S.mkCursor = 0; }
    else if (S.page === "mcp") { S.mcpItems = buildMcpList("All"); S.mcpCursor = 0; }
  }
}

// Re-read a plugin's config schema after a change so the editor shows fresh values.
function refreshConfigItems() {
  if (!S.configTarget) return;
  if (S.configTarget.global) {
    S.configItems = buildConfigItems({ defaults: GLOBAL_SETTINGS_DEFAULTS, current: loadGlobalSettings() });
    S.configTarget.items = S.configItems;
  } else {
    try {
      var out = execSync('node "' + S.configTarget.bundle + '" config schema', { encoding: "utf-8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
      var data = JSON.parse(String(out).trim());
      S.configItems = buildConfigItems(data);
      S.configTarget.items = S.configItems;
      // Keep the Settings tab's cached plugin section in sync so its rebuilt rows
      // show the freshly saved value (buildPluginSections reuses the cached probe).
      for (var pi = 0; pi < (S.pluginItems || []).length; pi++) {
        var pit = S.pluginItems[pi];
        if (pit && pit._cfg && pit._cfg.bundle === S.configTarget.bundle) { pit._cfg.items = S.configItems; break; }
      }
    } catch { /* keep stale view */ }
  }
  if (S.cfgcursor >= S.configItems.length) S.cfgcursor = Math.max(0, S.configItems.length - 1);
  // On the Settings tab, rebuild the unified rows so values + modified markers refresh.
  if (S.page === "settings") { try { refreshSettings(); } catch (e) {} }
}

// Free-text entry for a non-boolean config value; Enter saves via `config set`.
export function handleConfigInputData(buf) {
  if (buf[0] === 27) { S.inputBuf = ""; S.mode = "pconfig"; return; }   // esc cancels
  if (buf[0] === 13 || buf[0] === 10) {
    var val = S.inputBuf;
    var key = S.configEditKey;
    S.inputBuf = "";
    S.mode = "pconfig";
    if (S.configTarget && key) {
      var serr = S.configTarget.global ? setGlobalSetting(key, val) : setPluginConfig(S.configTarget.bundle, key, val);
      if (serr) flash(key + ": " + serr);
      else { refreshConfigItems(); flash(key + " saved (restart to apply)."); }
    }
    return;
  }
  if (buf[0] === 127 || buf[0] === 8) { S.inputBuf = S.inputBuf.slice(0, -1); return; }
  if (buf[0] >= 32 && buf[0] <= 126) S.inputBuf += String.fromCharCode(buf[0]);
}

// Free-text entry for the two config-ledger sub-modes in the Versioning tab:
// "sgprofinput" (new profile/branch name) and "sgurlinput" (remote URL). Mirrors
// handleConfigInputData's buf[0] byte-code convention (esc/enter/backspace/printable).
export function handleSettingsGitInputData(buf) {
  var m = getConfigLedger();
  if (buf[0] === 27) {   // esc cancels
    S.inputBuf = "";
    S.mode = (S.mode === "sgurlinput") ? "sgsetup" : "list";
    return;
  }
  if (buf[0] === 13 || buf[0] === 10) {   // enter commits
    var val = (S.inputBuf || "").trim();
    S.inputBuf = "";
    if (S.mode === "sgprofinput") {
      if (val && m) {
        try { m.profiles.create(val); m.profiles.switchTo(val); flash("Created profile " + val); }
        catch (e) { flash("Create failed: " + ((e && e.message) || e)); }
      }
      S.mode = "list"; refreshVersioning();
    } else {   // sgurlinput
      if (val && m) {
        try { m.setup.setRemote(val); flash("Remote set: " + val); }
        catch (e) { flash("Set remote failed: " + ((e && e.message) || e)); }
      }
      S.mode = "sgsetup";
    }
    return;
  }
  if (buf[0] === 127 || buf[0] === 8) { S.inputBuf = S.inputBuf.slice(0, -1); return; }   // backspace
  if (buf[0] >= 32 && buf[0] <= 126) S.inputBuf += String.fromCharCode(buf[0]);            // printable
}

export function handlePluginInputData(buf) {
  if (buf[0] === 27) { S.inputBuf = ""; S.mode = "list"; return; }
  if (buf[0] === 13 || buf[0] === 10) {
    var url = S.inputBuf.trim().replace(/\.git$/, "");
    S.inputBuf = "";
    S.mode = "list";
    if (!url) return;
    var name = url.split("/").pop() || url;
    var plugins = loadPlugins();
    if (!plugins.some(function(r) { return r.name === name; })) {
      plugins.push({ name: name, url: url, enabled: true, autoUpdate: true });
      savePlugins(plugins);
    }
    flash("Setting up " + name + "...");
    render();
    setupPlugin({ name: name, url: url }, function(err) {
      S.pluginItems = buildCombinedPluginList();
      flash(err ? name + ": " + err : name + " installed. Restart " + APP_NAME + " to load.");
      render();
    });
    return;
  }
  if (buf[0] === 127 || buf[0] === 8) { S.inputBuf = S.inputBuf.slice(0, -1); return; }
  if (buf[0] >= 32 && buf[0] <= 126) S.inputBuf += String.fromCharCode(buf[0]);
}

// Text entry for the two universal marketplace "add" actions (S.mode === "mkinput",
// S.mkAddAction picks which). "add_plugin_url" installs via the SAME updater path
// every other marketplace install uses (installMarketplacePlugin -> `plugin-updater add
// <url>`), so it works identically to the CLI's `plugins install <url>`. "add_marketplace"
// is generic, it just calls the app-registered S.capabilities.addMarketplace(input).
export function handleMarketplaceAddInputData(buf) {
  if (buf[0] === 27) { S.inputBuf = ""; S.mkAddAction = null; S.mode = "list"; return; }
  if (buf[0] === 3) { cleanup(); process.exit(1); }
  if (buf[0] === 13 || buf[0] === 10) {
    var val = S.inputBuf.trim();
    var action = S.mkAddAction;
    S.inputBuf = "";
    S.mkAddAction = null;
    S.mode = "list";
    if (!val) return;
    if (action === "add_plugin_url") {
      var url = val.replace(/\.git$/, "");
      S.busy = true;
      setBusyMessage("Installing plugin...");
      render();
      installMarketplacePlugin({ url: url }, function(err) {
        S.busy = false;
        if (err) flash(err);
        else { flash("Installed! Restart " + APP_NAME + " to activate."); S.pluginItems = buildCombinedPluginList(); }
        S.marketplaceItems = buildMarketplaceList();
        if (S.mkCursor >= S.marketplaceItems.length) S.mkCursor = Math.max(0, S.marketplaceItems.length - 1);
        render();
      });
    } else if (action === "add_marketplace") {
      var addFn = S.capabilities && S.capabilities.addMarketplace;
      if (typeof addFn !== "function") { flash("Not supported."); return; }
      var res = {};
      try { res = addFn(val) || {}; } catch (e) { res = { ok: false, error: (e && e.message) || String(e) }; }
      flash(res.ok ? "Added marketplace" : ("Failed: " + (res.error || "")));
    }
    return;
  }
  if (buf[0] === 127 || buf[0] === 8) { S.inputBuf = S.inputBuf.slice(0, -1); return; }
  if (buf[0] >= 32 && buf[0] <= 126) S.inputBuf += String.fromCharCode(buf[0]);
}

// Multi-step "＋ Add MCP server" flow (S.mode === "mcpaddinput"): step 0 collects
// a free-text name, step 1 toggles transport (http|stdio) via arrow keys (never
// typed), and step 2 collects the target (a URL for http, a command for stdio).
// Escape at any step cancels the whole flow (mirrors handleMarketplaceAddInputData).
// On completion, calls the app-registered S.capabilities.addMcpServer(draft).
export function handleMcpAddInputData(buf) {
  if (buf[0] === 3) { cleanup(); process.exit(1); }
  if (buf[0] === 27) {
    if (buf.length === 1) {
      S.mode = "list"; S.mcpAddStep = 0; S.mcpAddDraft = null; S.inputBuf = "";
      return;
    }
    // arrow keys during the transport step toggle the selection; ignored elsewhere
    if (S.mcpAddStep === 1 && buf[1] === 91 && (buf[2] === 65 || buf[2] === 66 || buf[2] === 67 || buf[2] === 68)) {
      S.mcpAddDraft.transport = S.mcpAddDraft.transport === "http" ? "stdio" : "http";
    }
    return;
  }
  if (buf[0] === 13 || buf[0] === 10) {
    if (S.mcpAddStep === 0) {
      var name = S.inputBuf.trim();
      if (!name) return;
      S.mcpAddDraft.name = name;
      S.inputBuf = "";
      S.mcpAddStep = 1;
      return;
    }
    if (S.mcpAddStep === 1) {
      S.mcpAddStep = 2;
      S.inputBuf = "";
      return;
    }
    // step 2: target, completes the flow
    var target = S.inputBuf.trim();
    S.mcpAddDraft.target = target;
    var draft = S.mcpAddDraft;
    S.mode = "list";
    S.mcpAddStep = 0;
    S.mcpAddDraft = null;
    S.inputBuf = "";
    var addFn = S.capabilities && S.capabilities.addMcpServer;
    if (typeof addFn !== "function") { flash("Not supported."); return; }
    var res = {};
    try { res = addFn(draft) || {}; } catch (e) { res = { ok: false, error: (e && e.message) || String(e) }; }
    flash(res.ok ? "Added MCP server" : ("Failed: " + (res.error || "")));
    return;
  }
  if (S.mcpAddStep === 1) return;   // no free text on the transport step
  if (buf[0] === 127 || buf[0] === 8) { S.inputBuf = S.inputBuf.slice(0, -1); return; }
  if (buf[0] >= 32 && buf[0] <= 126) S.inputBuf += String.fromCharCode(buf[0]);
}

// raw text input routed to the active custom tab when it sets S.mode="tabinput"
// (the parseKey whitelist can't deliver free text); the tab toggles back to "list"
export function handleTabInputData(buf) {
  var activeTab = S.customTabs.find(function(t) { return t.id === S.pluginSubPage; });
  if (!activeTab || !activeTab.handleKey) { S.mode = "list"; return; }
  var key = null;
  if (buf[0] === 3) { cleanup(); process.exit(1); }
  else if (buf[0] === 27 && buf.length === 1) key = "escape";
  else if (buf[0] === 27 && buf[1] === 91) {
    if (buf[2] === 65) key = "up"; else if (buf[2] === 66) key = "down";
    else if (buf[2] === 67) key = "right"; else if (buf[2] === 68) key = "left";
    else return;
  }
  else if (buf[0] === 13 || buf[0] === 10) key = "enter";
  else if (buf[0] === 9) key = "tab";
  else if (buf[0] === 127 || buf[0] === 8) key = "backspace";
  else if (buf[0] >= 32 && buf[0] < 127) {
    // collect the whole printable run so a PASTE (multi-byte, e.g. a long redirect
    // URL) arrives as one key instead of just the first character
    var s = ""; for (var bi = 0; bi < buf.length; bi++) { var c = buf[bi]; if (c >= 32 && c < 127) s += String.fromCharCode(c); }
    if (!s) return; key = s;
  }
  else return;
  try { activeTab.handleKey(key, { pluginSubPage: S.pluginSubPage, mode: S.mode }, tuiApi); } catch(e) {}
}

