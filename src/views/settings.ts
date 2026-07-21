// @ts-nocheck
// Settings tab: two sub-tabs (Tab switches): "Settings" (global + plugin settings, here)
// and "Versioning" (config-ledger git UI, delegated to views/versioning.ts).
// Plugin config schemas are probed in the BACKGROUND (async) with a spinner, so entering
// the tab never blocks; plugin rows show "loading…" until their schema resolves.

import { RST, BOLD, DIM, GRAY, WHITE, OK, BG_SEL, stringWidth, pad, trunc, ACCENT, rule } from "../format.js";
import { S } from "../state.js";
import { buildGlobalSection, buildSettingsEntries, firstSelectableIndex } from "../settings-model.js";
import { probeConfigSchemaAsync } from "../plugins.js";
import { hints, messageLine, spinnerFrame, scheduleRender } from "./common.js";
import { buildVersioning } from "./versioning.js";

// Rebuild the section model + entry list from ALREADY-PROBED schemas only (no spawning).
// Un-probed plugins become "loading" placeholders; buildSectionsFromCache never blocks.
function buildSectionsFromCache() {
  const sections = [buildGlobalSection()];
  const loading = [];
  const plugins = (S.pluginItems && S.pluginItems.length) ? S.pluginItems : [];
  for (const p of plugins) {
    if (p._cfgProbed === true) {
      const cfg = p._cfg;
      if (cfg && cfg.items && cfg.items.length) {
        const name = cfg.name || p.name;
        sections.push({ label: name, kind: "plugin", file: name + ".json", bundle: cfg.bundle, items: cfg.items });
      }
    } else {
      loading.push(p.name);
    }
  }
  S.settingsSections = sections;
  S.settingsEntries = buildSettingsEntries(sections, loading);
  var cur = S.settingsEntries[S.settingsCursor];
  if (!cur || cur.type !== "group") S.settingsCursor = firstSelectableIndex(S.settingsEntries);
}

// Kick off async schema probes for any plugin not yet probed. S.catalogPending drives the
// shared spinner (updateSpinner in render); scheduleRender coalesces the burst of redraws.
function probeSettingsSchemas() {
  const plugins = (S.pluginItems && S.pluginItems.length) ? S.pluginItems : [];
  for (const p of plugins) {
    if (p._cfgProbed === true || p._cfgProbing === true) continue;
    p._cfgProbing = true;
    S.catalogPending++;
    probeConfigSchemaAsync(p).then(function (cfg) {
      p._cfg = cfg; p._cfgProbed = true; p._cfgProbing = false;
      S.catalogPending = Math.max(0, S.catalogPending - 1);
      buildSectionsFromCache();
      scheduleRender();
    });
  }
}

export function refreshSettings(): void {
  buildSectionsFromCache();
  probeSettingsSchemas();
}

export function buildSettings(pushBody, pushFoot, cols, barW, pushSticky) {
  var sub = S.settingsSubPage || "settings";

  // Sub-tab bar (Settings | Versioning) + a blank line, shown only at the list level.
  if (S.mode === "list") {
    var t1 = sub === "settings" ? (BOLD + ACCENT + BG_SEL + " Settings " + RST) : (GRAY + " Settings " + RST);
    var t2 = sub === "versioning" ? (BOLD + ACCENT + BG_SEL + " Versioning " + RST) : (GRAY + " Versioning " + RST);
    pushSticky("  " + t1 + "  " + t2 + "    " + DIM + "tab switch" + RST);
    pushSticky("");
  }

  if (sub === "versioning") { buildVersioning(pushBody, pushFoot, cols, barW, pushSticky); return; }

  // --- Settings sub-tab ---
  if (S.mode === "pconfig" || S.mode === "pcfginput") {
    var ct = S.configTarget;
    var cname = (ct && ct.name) || "settings";
    var cfile = (ct && ct.file) || "settings.json";
    pushBody("  " + BOLD + WHITE + "Configure " + trunc(cname, cols - 16) + RST, false);
    pushBody("  " + GRAY + "changes save to config/" + cfile + " (restart to apply)" + RST, false);
    pushBody("", false);
    var keyW = 6;
    for (var ck = 0; ck < S.configItems.length; ck++) keyW = Math.max(keyW, stringWidth(S.configItems[ck].key));
    keyW = Math.min(keyW, Math.max(12, Math.floor(cols / 2)));
    for (var ci = 0; ci < S.configItems.length; ci++) {
      var it = S.configItems[ci];
      var csel = ci === S.cfgcursor;
      var editing = S.mode === "pcfginput" && csel;
      var valStr;
      if (editing) valStr = BG_SEL + " " + S.inputBuf + BOLD + "|" + RST;
      else if (it.type === "boolean") valStr = (it.value ? OK + "true" : GRAY + "false") + RST;
      else valStr = WHITE + JSON.stringify(it.value) + RST;
      var mark = it.isSet ? "" : (GRAY + " (default)" + RST);
      var carrow = csel ? (ACCENT + " ❯ " + RST) : "   ";
      var cbg = csel ? BG_SEL : "";
      var cNameStyle = csel ? (BOLD + WHITE) : DIM;
      pushBody("  " + cbg + carrow + cNameStyle + pad(trunc(it.key, keyW), keyW) + RST + cbg + "  " + valStr + mark + RST, csel);
    }
    pushBody("", false);
    if (S.message) pushFoot(messageLine(cols));
    pushFoot("  " + rule(barW));
    if (S.mode === "pcfginput") pushFoot(hints([["enter", "save"], ["esc", "cancel"]]));
    else pushFoot(hints([["↑↓", "move"], ["enter", "edit/toggle"], ["esc", "back"]]));
    return;
  }

  // Group list.
  if (!S.settingsEntries || !S.settingsEntries.length) refreshSettings();

  var nameW = 6;
  for (var wi = 0; wi < S.settingsEntries.length; wi++) {
    var we = S.settingsEntries[wi];
    if (we.type === "group") nameW = Math.max(nameW, stringWidth(we.section.label));
    else if (we.type === "loading") nameW = Math.max(nameW, stringWidth(we.label));
  }
  nameW = Math.min(nameW, Math.max(16, Math.floor(cols / 2)));

  for (var i = 0; i < S.settingsEntries.length; i++) {
    var en = S.settingsEntries[i];
    if (en.type === "header") {
      if (i > 0) pushBody("", false);   // blank line before each section header (except the first)
      pushBody("  " + BOLD + WHITE + en.label + RST, false);
      continue;
    }
    if (en.type === "loading") {
      pushBody("     " + spinnerFrame() + " " + DIM + pad(trunc(en.label, nameW), nameW) + RST + "  " + GRAY + "loading…" + RST, false);
      continue;
    }
    var sel = i === S.settingsCursor;
    var arrow = sel ? (ACCENT + " ❯ " + RST) : "   ";
    var bg = sel ? BG_SEL : "";
    var nameStyle = sel ? (BOLD + WHITE) : DIM;
    var sec = en.section;
    var n = sec.items.length;
    var count = n + (n === 1 ? " setting" : " settings");
    pushBody("  " + bg + arrow + nameStyle + pad(trunc(sec.label, nameW), nameW) + RST + bg + "  " + GRAY + pad(count, 12) + RST, sel);
  }

  pushBody("", false);
  if (S.message) pushFoot(messageLine(cols));
  pushFoot("  " + rule(barW));
  pushFoot(hints([["↑↓", "move"], ["enter", "open"], ["tab", "switch"], ["?", "help"], ["q", "quit"]]));
}
