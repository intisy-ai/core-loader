# config-git Loader Settings Tab (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn core-loader's existing global-only Settings tab into a git-aware *unified* Settings tab that lists global + every plugin's settings, and lights up config-git features (modified-vs-repo markers, commit/push/pull with review-gated diff, per-key history + rollback, profiles picker, repo setup) by delegating to `repos/config-git/dist/lib.js` when it is installed.

**Architecture:** Phase 1 already shipped the standalone `config-git` plugin (shadow repo + sanitized snapshots + `dist/lib.js` ESM library). This phase is loader-side only: a new thin delegation module dynamically imports that lib (returning `null` when absent, exactly like `updater.ts` / plugin-updater's `syncbridge.ts`), a pure settings-model module builds the unified section list by reusing the loader's existing `config schema` probe, and the existing `views/settings.ts` + `handleSettingsKey` are extended with the unified list plus git sub-screens. When the lib is absent the tab keeps working as a plain multi-plugin config editor.

**Tech Stack:** TypeScript (compiled with `tsc` to `dist/`), Node >= 20 ESM, dynamic `import()` of an ESM lib, the loader's hand-rolled ANSI TUI (no framework), plain `.mjs` + `node:assert` tests run with `node`.

## Global Constraints

- **This is an EXTENSION, not a new tab.** The top-level `settings` view already exists end-to-end (registry `["projects","plugins","mcp","settings"]` in `src/input.ts:194`, tab label in `src/views/render.ts:47-51`, dispatch in `src/views/render.ts:58-66`, `handleSettingsKey` in `src/input.ts:948-989`, renderer `buildSettings` in `src/views/settings.ts`, state `settingsCursor` / `settingsScrollOff` in `src/state.ts:82-84`). Do not add a new page string; extend these.
- **Loaders stay provider-agnostic.** Only the generic config-git lib contract may be named/consumed. Never hardcode a provider or model family. (Only `plugin-updater` and now `config-git` may be named in loader code -- both are ecosystem infrastructure, not providers.)
- **Delegate, hide when absent.** When `repos/config-git/dist/lib.js` is missing OR its expected exports are not functions, git features are hidden and plain settings editing keeps working. Same rule as `plugin-updater` (`src/views/plugins.ts:91-94`, `120-132`).
- **Never touch live config without an approved diff** -- except that config-git's own auto-commit (on plugin load) only reads live state. The loader's commit/push/pull/import/rollback/profile-switch are all user-initiated; import and profile-switch are gated behind the setting-level diff screen.
- **Diff rows use field `file`, not `plugin`.** config-git `diffAgainstHead()` returns `{ file, key, old, new }` (all strings). Use `file`.
- **config-git lib functions are synchronous** once the module is imported. Only the dynamic `import()` in `preloadConfigGit()` is async. Wrappers call the cached module and invoke sync methods directly.
- **App-home wiring:** before importing the lib, set `process.env.HUB_CONFIG_DIR = CONFIG_DIR` so config-git's `getAppConfigDir()` resolves the same home the loader manages (`CONFIG_DIR` from `src/env.ts:20`). config-git resolves paths lazily at call time, so setting it before the first call suffices.
- **Lib path:** `join(REPOS_DIR, "config-git", "dist", "lib.js")` where `REPOS_DIR = join(CONFIG_DIR, "repos")` (`src/env.ts:33`). Note the *data* repo is a different dir (`config-git-data`); the lib lives in the plugin clone `config-git`.
- **Code style (repo CLAUDE.md):** one concern per file; shared mutable state only via the single `S` object in `src/state.ts` (mutate properties, never reassign the import); split a file that grows past ~300-400 lines. TypeScript only in `src/`; `dist/` is rebuilt, never committed.
- **Tests:** core-loader has no vitest. Follow the existing convention -- pure-logic modules get a `test/<name>.test.mjs` that imports from `../dist/<name>.js`, asserts with `node:assert`, and prints `<name>.test.mjs OK`. Run with `node test/<name>.test.mjs` (after `npm run build`). TUI rendering / key-handling is verified manually (steps included per task).
- **config-git lib exports consumed** (from `dist/lib.js`, all sync unless noted): `diffAgainstHead()` returns `[{file,key,old,new}]`; `exportLive()` returns number; `autoCommit(reason)` returns boolean; `importFromHead()` returns number; `keyHistory(file,key)` returns `[{hash,date,value}]`; `rollbackKey(file,key,hash)` returns boolean; `profiles.{list()->string[], current()->string, create(name), switchTo(name)}`; `repo.{isRepo()->boolean, currentBranch()->string, getRemote()->string, hasRemote()->boolean, push()->{ok,message}, pull()->{ok,message}, log(rel)->[{hash,date,subject}]}`; `setup.{initAndSeed()->boolean, setRemote(url)->string, ghAvailable()->boolean, ghCreatePrivate(name)->{ok,url}|{ok:false,message}}`; `getConfig()->{secrets,logging}`; `configDir()`; `dataRepoDir()`.

---

### Task 1: config-git delegation module

**Files:**
- Create: `src/config-git.ts`
- Modify: `src/state.ts` (add cached-module + git-data fields)
- Test: `test/config-git.test.mjs`

**Interfaces:**
- Consumes: `CONFIG_DIR`, `REPOS_DIR` from `src/env.ts`; `S` from `src/state.ts`; `tuiLog` from `src/env.ts` (file logger `tuiLog(msg, isError?)`).
- Produces:
  - `resolveConfigGitLib(): string | null` -- absolute path to `dist/lib.js` or null.
  - `preloadConfigGit(): Promise<void>` -- sets `HUB_CONFIG_DIR`, dynamic-imports the lib, caches on `S.CONFIG_GIT_MODULE` (or leaves it `null`).
  - `getConfigGit(): any | null` -- cached module or null.
  - `configGitInstalled(): boolean` -- lib module present with the expected functions.
  - `configGitReady(): boolean` -- installed AND `repo.isRepo()` returns true.
  - `diffKeyId(file: string, key: string): string` -- pure join using a NUL separator so `"a.b"` + `"c"` never collides with `"a"` + `"b.c"`.
  - `buildDiffSet(rows: Array<{file:string,key:string}>): Set<string>` -- pure, `Set` of `diffKeyId`.

- [ ] **Step 1: Write the failing test**

Create `test/config-git.test.mjs`:

```js
import assert from "node:assert";
import { diffKeyId, buildDiffSet, resolveConfigGitLib } from "../dist/config-git.js";

// diffKeyId joins file+key with a NUL separator (collision-proof)
const SEP = String.fromCharCode(0);
assert.equal(diffKeyId("core-auth.json", "leaderboard.enabled"), "core-auth.json" + SEP + "leaderboard.enabled");

// buildDiffSet turns diff rows into an O(1) membership set keyed by file+key
const set = buildDiffSet([
  { file: "settings.json", key: "logConsole", old: "false", new: "true" },
  { file: "core-auth.json", key: "leaderboard.enabled", old: "true", new: "false" },
]);
assert.equal(set.has(diffKeyId("settings.json", "logConsole")), true);
assert.equal(set.has(diffKeyId("core-auth.json", "leaderboard.enabled")), true);
assert.equal(set.has(diffKeyId("settings.json", "logColor")), false);
assert.equal(buildDiffSet([]).size, 0);

// resolveConfigGitLib returns a string|null and never throws
const r = resolveConfigGitLib();
assert.ok(r === null || typeof r === "string");

console.log("config-git.test.mjs OK");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd F:/Documents/GitHub/javascript/libs/core-loader && node test/config-git.test.mjs`
Expected: FAIL -- `Cannot find module '../dist/config-git.js'` (module not built yet).

- [ ] **Step 3: Add state fields**

In `src/state.ts`, inside the `S` object beside the Settings fields at lines 82-84, add:

```js
  // config-git (Phase 2) -- cached lib module + git-data caches for the Settings tab
  CONFIG_GIT_MODULE: null,   // resolved dist/lib.js module, or null when absent
  cgDiffRows: [],            // last diffAgainstHead() rows (markers + review screen)
  cgHistory: [],             // last keyHistory() rows (history sub-screen)
  cgHistoryFile: "",         // file the history sub-screen is showing
  cgHistoryKey: "",          // key the history sub-screen is showing
  cgHistoryCursor: 0,
  cgProfiles: [],            // profiles.list() snapshot
  cgProfileCurrent: "",      // profiles.current()
  cgProfileCursor: 0,
```

- [ ] **Step 4: Write the delegation module**

Create `src/config-git.ts`:

```ts
// config-git delegation: dynamically import the plugin's dist/lib.js when present,
// return null when absent. Mirrors src/updater.ts (preloadUpdater/getUpdater) and
// plugin-updater's syncbridge.ts resolver. Loaders delegate; hide features if absent.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG_DIR, REPOS_DIR, tuiLog } from "./env.js";
import { S } from "./state.js";

// NUL separator: no config file name or dotted key ever contains a NUL byte.
const SEP = String.fromCharCode(0);

// The plugin clone (not the data repo) holds the library entry point.
export function resolveConfigGitLib(): string | null {
  const p = join(REPOS_DIR, "config-git", "dist", "lib.js");
  return existsSync(p) ? p : null;
}

export async function preloadConfigGit(): Promise<void> {
  const libPath = resolveConfigGitLib();
  if (!libPath) { tuiLog("config-git not installed; git settings features disabled"); return; }
  // Pin config-git to the same app home the loader manages.
  process.env.HUB_CONFIG_DIR = CONFIG_DIR;
  try {
    const mod: any = await import(pathToFileURL(libPath).href);
    if (typeof mod.diffAgainstHead !== "function" || !mod.repo || typeof mod.repo.isRepo !== "function") {
      tuiLog("config-git lib present but missing expected exports (older version); disabling", true);
      return;
    }
    S.CONFIG_GIT_MODULE = mod;
  } catch (e: any) {
    tuiLog("config-git lib import failed: " + ((e && e.message) || e), true);
  }
}

export function getConfigGit(): any | null {
  return S.CONFIG_GIT_MODULE;
}

export function configGitInstalled(): boolean {
  return !!S.CONFIG_GIT_MODULE;
}

export function configGitReady(): boolean {
  const m = S.CONFIG_GIT_MODULE;
  if (!m) return false;
  try { return m.repo.isRepo() === true; } catch { return false; }
}

// --- pure helpers (unit-tested) ---
export function diffKeyId(file: string, key: string): string {
  return file + SEP + key;
}

export function buildDiffSet(rows: Array<{ file: string; key: string }>): Set<string> {
  const set = new Set<string>();
  for (const r of rows || []) set.add(diffKeyId(r.file, r.key));
  return set;
}
```

Note: `tuiLog` must be exported from `src/env.ts`. It already exists there (the file logger lives in `env.ts`); if it is not exported, add `export` to its declaration in this step.

- [ ] **Step 5: Build and run the test to verify it passes**

Run: `cd F:/Documents/GitHub/javascript/libs/core-loader && npm run build && node test/config-git.test.mjs`
Expected: PASS -- prints `config-git.test.mjs OK`.

- [ ] **Step 6: Commit**

```bash
git add src/config-git.ts src/state.ts test/config-git.test.mjs
git commit -m "feat(loader): config-git delegation module (resolve/import/guard + diff-set helpers)"
```

---

### Task 2: Unified settings-model builder

**Files:**
- Create: `src/settings-model.ts`
- Test: `test/settings-model.test.mjs`

**Interfaces:**
- Consumes: `probeConfigSchema`, `buildConfigItems` from `src/plugins.ts`; `GLOBAL_SETTINGS_DEFAULTS`, `loadGlobalSettings` from `src/config.ts`; `diffKeyId` from `src/config-git.ts`.
- Produces:
  - Type `SettingsItem = { key: string; value: unknown; def: unknown; isSet: boolean; type: string }` (matches `buildConfigItems` output).
  - Type `SettingsSection = { label: string; kind: "global" | "plugin"; file: string; bundle: string | null; items: SettingsItem[] }`. `file` is the tracked config file name (`"settings.json"` for global, `"<configName>.json"` for a plugin). `bundle` is the plugin bundle path (null for global) used by `setPluginConfig` / `config schema`.
  - Type `SettingsRow = { type: "header" | "item"; label?: string; sectionIndex: number; itemIndex?: number; item?: SettingsItem; file?: string; bundle?: string | null; kind?: "global" | "plugin"; modified: boolean }`.
  - `buildGlobalSection(): SettingsSection` -- the global settings section.
  - `buildPluginSections(pluginItems: any[]): SettingsSection[]` -- one section per plugin whose `config schema` probe yields items; reuses each plugin item's cached `_cfg` when present, else probes.
  - `flattenRows(sections: SettingsSection[], diffSet: Set<string>): SettingsRow[]` -- header row per section followed by its item rows; each item row's `modified` = `diffSet.has(diffKeyId(section.file, item.key))`.
  - `firstItemIndex(rows: SettingsRow[]): number` -- index of the first `item` row (0 if none), for initial cursor placement.

- [ ] **Step 1: Write the failing test**

Create `test/settings-model.test.mjs`:

```js
import assert from "node:assert";
import { flattenRows, firstItemIndex } from "../dist/settings-model.js";
import { diffKeyId } from "../dist/config-git.js";

const sections = [
  { label: "Global", kind: "global", file: "settings.json", bundle: null, items: [
    { key: "logConsole", value: false, def: false, isSet: false, type: "boolean" },
    { key: "logColor", value: true, def: true, isSet: false, type: "boolean" },
  ]},
  { label: "core-auth", kind: "plugin", file: "core-auth.json", bundle: "/x/core-auth.js", items: [
    { key: "leaderboard.enabled", value: true, def: false, isSet: true, type: "boolean" },
  ]},
];
const diffSet = new Set([diffKeyId("core-auth.json", "leaderboard.enabled")]);
const rows = flattenRows(sections, diffSet);

// header, 2 items, header, 1 item = 5 rows
assert.equal(rows.length, 5);
assert.equal(rows[0].type, "header");
assert.equal(rows[0].label, "Global");
assert.equal(rows[1].type, "item");
assert.equal(rows[1].file, "settings.json");
assert.equal(rows[1].modified, false);
assert.equal(rows[3].type, "header");
assert.equal(rows[3].label, "core-auth");
assert.equal(rows[4].type, "item");
assert.equal(rows[4].modified, true);          // in the diff set
assert.equal(rows[4].bundle, "/x/core-auth.js");

// first item row is index 1 (index 0 is a header)
assert.equal(firstItemIndex(rows), 1);
// all-headers -> 0
assert.equal(firstItemIndex([{ type: "header", label: "x", sectionIndex: 0, modified: false }]), 0);

console.log("settings-model.test.mjs OK");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd F:/Documents/GitHub/javascript/libs/core-loader && node test/settings-model.test.mjs`
Expected: FAIL -- `Cannot find module '../dist/settings-model.js'`.

- [ ] **Step 3: Write the settings-model module**

Create `src/settings-model.ts`:

```ts
// Pure builder for the unified Settings tab: assembles the global settings section
// plus one section per plugin that has a config schema, and flattens them into
// render rows (headers + items) with modified-vs-repo flags. No I/O in flattenRows.
import { probeConfigSchema, buildConfigItems } from "./plugins.js";
import { GLOBAL_SETTINGS_DEFAULTS, loadGlobalSettings } from "./config.js";
import { diffKeyId } from "./config-git.js";

export type SettingsItem = { key: string; value: unknown; def: unknown; isSet: boolean; type: string };
export type SettingsSection = { label: string; kind: "global" | "plugin"; file: string; bundle: string | null; items: SettingsItem[] };
export type SettingsRow = {
  type: "header" | "item";
  label?: string;
  sectionIndex: number;
  itemIndex?: number;
  item?: SettingsItem;
  file?: string;
  bundle?: string | null;
  kind?: "global" | "plugin";
  modified: boolean;
};

export function buildGlobalSection(): SettingsSection {
  const items = buildConfigItems({ defaults: GLOBAL_SETTINGS_DEFAULTS, current: loadGlobalSettings() }) as SettingsItem[];
  return { label: "Global", kind: "global", file: "settings.json", bundle: null, items };
}

export function buildPluginSections(pluginItems: any[]): SettingsSection[] {
  const out: SettingsSection[] = [];
  for (const p of pluginItems || []) {
    // reuse a cached probe if the Plugins tab already ran it; else probe now
    let cfg = p && p._cfg;
    if (p && p._cfgProbed !== true) { cfg = probeConfigSchema(p); p._cfg = cfg; p._cfgProbed = true; }
    if (!cfg || !cfg.items || !cfg.items.length) continue;
    const name = cfg.name || p.name;
    out.push({ label: name, kind: "plugin", file: name + ".json", bundle: cfg.bundle, items: cfg.items });
  }
  return out;
}

export function flattenRows(sections: SettingsSection[], diffSet: Set<string>): SettingsRow[] {
  const rows: SettingsRow[] = [];
  for (let s = 0; s < sections.length; s++) {
    const sec = sections[s];
    rows.push({ type: "header", label: sec.label, sectionIndex: s, modified: false });
    for (let i = 0; i < sec.items.length; i++) {
      const it = sec.items[i];
      rows.push({
        type: "item", sectionIndex: s, itemIndex: i, item: it,
        file: sec.file, bundle: sec.bundle, kind: sec.kind,
        modified: diffSet.has(diffKeyId(sec.file, it.key)),
      });
    }
  }
  return rows;
}

export function firstItemIndex(rows: SettingsRow[]): number {
  for (let i = 0; i < rows.length; i++) if (rows[i].type === "item") return i;
  return 0;
}
```

- [ ] **Step 4: Build and run the test to verify it passes**

Run: `cd F:/Documents/GitHub/javascript/libs/core-loader && npm run build && node test/settings-model.test.mjs`
Expected: PASS -- prints `settings-model.test.mjs OK`.

- [ ] **Step 5: Commit**

```bash
git add src/settings-model.ts test/settings-model.test.mjs
git commit -m "feat(loader): unified settings-model (global + plugin sections, flattened rows with modified flags)"
```

---

### Task 3: Unified list rendering + editing + preload wiring

**Files:**
- Modify: `src/views/settings.ts` (render the unified list + markers + git-status sticky)
- Modify: `src/input.ts` (`handleSettingsKey` list nav over rows; enter opens the shared `pconfig` editor scoped to the row's section)
- Modify: `src/tui.ts` (call `preloadConfigGit()` during boot, next to `preloadUpdater()`)
- Modify: `src/state.ts` (add `settingsRows`, `settingsSections` caches)

**Interfaces:**
- Consumes: `buildGlobalSection`, `buildPluginSections`, `flattenRows`, `firstItemIndex` from `src/settings-model.ts`; `configGitInstalled`, `configGitReady`, `getConfigGit`, `buildDiffSet` from `src/config-git.ts`; the installed-plugin item array the Plugins tab renders (`S.pluginItems`); color tokens + `pad` / `trunc` / `stringWidth` / `rule` from `src/format.ts`; `hints` / `flash` from `src/views/common.ts`; existing `setGlobalSetting` / `setPluginConfig` save paths.
- Produces:
  - `refreshSettings(): void` in `src/views/settings.ts` -- rebuilds `S.settingsSections` and `S.settingsRows` (recomputing the diff set from `getConfigGit().diffAgainstHead()` when ready), clamps `S.settingsCursor` to a valid item row.
  - `buildSettings(pushBody, pushFoot, cols, barW, pushSticky)` -- extended renderer.

- [ ] **Step 1: Add row caches to state**

In `src/state.ts`, beside the Task-1 additions, add:

```js
  settingsSections: [],  // SettingsSection[] built on tab entry / refresh
  settingsRows: [],       // SettingsRow[] flattened for rendering + nav
```

- [ ] **Step 2: Write `refreshSettings` + extend the renderer**

In `src/views/settings.ts`, add the refresh builder and rewrite the list portion of `buildSettings`. Keep the existing `pconfig` / `pcfginput` edit overlay (lines 15-44) unchanged -- it is reused as-is. Add these imports at the top of the file:

```ts
import { buildGlobalSection, buildPluginSections, flattenRows, firstItemIndex } from "../settings-model.js";
import { configGitInstalled, configGitReady, getConfigGit, buildDiffSet } from "../config-git.js";
```

Add `refreshSettings`:

```ts
export function refreshSettings(): void {
  const sections = [buildGlobalSection()];
  const plugins = (S.pluginItems && S.pluginItems.length) ? S.pluginItems : [];
  for (const sec of buildPluginSections(plugins)) sections.push(sec);
  S.settingsSections = sections;

  let diffSet = new Set<string>();
  if (configGitReady()) {
    try { S.cgDiffRows = getConfigGit().diffAgainstHead() || []; } catch { S.cgDiffRows = []; }
    diffSet = buildDiffSet(S.cgDiffRows);
  } else {
    S.cgDiffRows = [];
  }
  S.settingsRows = flattenRows(sections, diffSet);
  // clamp cursor to a valid item row
  if (!S.settingsRows[S.settingsCursor] || S.settingsRows[S.settingsCursor].type !== "item") {
    S.settingsCursor = firstItemIndex(S.settingsRows);
  }
}
```

> Implementer note: `S.pluginItems` is the array the Plugins tab fills. If it is empty when the Settings tab is first opened (the user never visited Plugins), the plugin sections will be empty until the plugin list is built. Confirm where the Plugins tab populates `S.pluginItems` (in `src/plugins.ts`); if there is an exported builder (e.g. the function the Plugins tab calls on entry), call it here first so plugin sections appear on a cold open. If no such export exists, reading `S.pluginItems` is sufficient (sections fill in once Plugins has been visited) -- do not add a new plugin-list builder in this task.

Rewrite the list rendering (the branch that today renders global-only rows, `settings.ts:46-77`) to render the unified rows. Use the same glyphs/idioms the file already uses (selection arrow, `BG_SEL`, `(default)` marker):

```ts
  // (inside buildSettings, list mode -- S.mode not in the git/edit sub-modes)
  if (!S.settingsRows || !S.settingsRows.length) refreshSettings();

  const cg = configGitInstalled();
  if (cg && configGitReady()) {
    const m = getConfigGit();
    let branch = "", remote = "";
    try { branch = m.repo.currentBranch(); } catch {}
    try { remote = m.repo.hasRemote() ? m.repo.getRemote() : "(no remote)"; } catch { remote = "(no remote)"; }
    const dirty = (S.cgDiffRows && S.cgDiffRows.length) ? (BAD + S.cgDiffRows.length + " uncommitted" + RST) : (OK + "clean" + RST);
    pushSticky("  " + BOLD + WHITE + "Settings" + RST + DIM + "  config-git " + RST + ACCENT + branch + RST + DIM + "  " + RST + remote + DIM + "  " + RST + dirty);
  } else if (cg) {
    pushSticky("  " + BOLD + WHITE + "Settings" + RST + DIM + "  config-git installed -- press " + RST + ACCENT + "g" + RST + DIM + " to set up the repo" + RST);
  } else {
    pushSticky("  " + BOLD + WHITE + "Settings" + RST + DIM + "  global + plugin settings (install config-git for versioning)" + RST);
  }
  pushSticky("");

  // column width from the widest key across all sections
  let keyW = 6;
  for (const r of S.settingsRows) if (r.type === "item") keyW = Math.max(keyW, stringWidth(r.item.key));
  keyW = Math.min(keyW, Math.max(12, Math.floor(cols / 2)));

  for (let i = 0; i < S.settingsRows.length; i++) {
    const r = S.settingsRows[i];
    if (r.type === "header") {
      pushBody("  " + BOLD + INFO + r.label + RST, false);
      continue;
    }
    const it = r.item;
    const sel = i === S.settingsCursor;
    const arrow = sel ? (ACCENT + " > " + RST) : "   ";     // use the file's existing selection glyph
    const bg = sel ? BG_SEL : "";
    const nameStyle = sel ? (BOLD + WHITE) : DIM;
    let valStr;
    if (it.type === "boolean") valStr = (it.value ? OK + "true" : GRAY + "false") + RST;
    else valStr = WHITE + JSON.stringify(it.value) + RST;
    const marker = r.modified ? (BAD + " *" + RST) : (it.isSet ? "" : (GRAY + " (default)" + RST));  // modified marker; match the file's glyph vocabulary
    pushBody("    " + bg + arrow + nameStyle + pad(trunc(it.key, keyW), keyW) + RST + bg + "  " + valStr + marker + RST, sel);
  }

  pushFoot("  " + rule(barW));
  if (cg && configGitReady()) {
    pushFoot(hints([["up/down", "move"], ["enter", "edit"], ["h", "history"], ["g", "git"], ["p", "profiles"], ["?", "help"], ["q", "quit"]]));
  } else if (cg) {
    pushFoot(hints([["up/down", "move"], ["enter", "edit"], ["g", "setup"], ["?", "help"], ["q", "quit"]]));
  } else {
    pushFoot(hints([["up/down", "move"], ["enter", "edit"], ["?", "help"], ["q", "quit"]]));
  }
```

> Glyph note: the existing `settings.ts` uses a specific selection arrow and marker vocabulary (check its current `buildSettings` -- e.g. the ` > ` arrow and status glyphs). Reuse those exact glyphs rather than the ASCII placeholders above so the new rows match the rest of the TUI. Ensure the color/format tokens `INFO`, `OK`, `BAD`, `BG_SEL`, `pad`, `trunc`, `stringWidth`, `rule` are imported from `../format.js`.

- [ ] **Step 3: Rewrite `handleSettingsKey` list-mode nav + enter**

In `src/input.ts`, replace the list-mode portion of `handleSettingsKey` (`input.ts:970-989`) so nav walks `S.settingsRows` skipping headers, and enter opens the shared `pconfig` editor scoped to the row's section. Keep the existing `pconfig` / `pcfginput` block (`input.ts:948-968`) unchanged. Add the imports `import { refreshSettings } from "./views/settings.js";` and `import { configGitReady } from "./config-git.js";` at the top of `input.ts`.

```js
  // --- list mode ---
  if (key === "q" || key === "escape") { cleanup(); process.exit(1); return; }
  if (!S.settingsRows || !S.settingsRows.length) refreshSettings();

  function stepCursor(dir) {
    var n = S.settingsRows.length;
    var i = S.settingsCursor;
    for (var step = 0; step < n; step++) {
      i += dir;
      if (i < 0 || i >= n) return;                 // clamp at ends
      if (S.settingsRows[i] && S.settingsRows[i].type === "item") { S.settingsCursor = i; return; }
    }
  }
  if (key === "up" || key === "w") { stepCursor(-1); return; }
  if (key === "down" || key === "s") { stepCursor(1); return; }

  var row = S.settingsRows[S.settingsCursor];
  if ((key === "enter" || key === "space") && row && row.type === "item") {
    var sec = S.settingsSections[row.sectionIndex];
    S.configTarget = (sec.kind === "global")
      ? { name: "settings", global: true, file: sec.file, items: sec.items }
      : { name: sec.label, bundle: sec.bundle, file: sec.file, items: sec.items };
    S.configItems = sec.items;
    S.cfgcursor = row.itemIndex;
    S.cfgScrollOff = 0;
    S.mode = "pconfig";
    return;
  }
```

> Note: this reuses the tested `pconfig` / `pcfginput` overlay and its save routing (`handleConfigInputData` at `input.ts:1129-1145`, which branches on `S.configTarget.global`). The only change to that path: after a successful save it must refresh markers/values. In `refreshConfigItems` (`input.ts:1112-1126`), after the existing global/plugin re-read, add: `if (S.page === "settings") { try { refreshSettings(); } catch {} }`.

The git sub-mode keys (`g`, `h`, `p`) are added in Tasks 4-6. For this task, leave them unhandled (no-op) so the list works standalone.

- [ ] **Step 4: Wire `preloadConfigGit()` into boot**

In `src/tui.ts`, find where `preloadUpdater()` is awaited during boot. Add alongside it:

```js
import { preloadConfigGit } from "./config-git.js";
// ... in the same boot phase that preloads the updater:
await preloadConfigGit();
```

If the boot preloads run concurrently, add `preloadConfigGit()` to that `Promise.all`.

- [ ] **Step 5: Build and manually verify the unified list**

Run: `cd F:/Documents/GitHub/javascript/libs/core-loader && npm run build`
Expected: clean build (no TS errors).

Then verify behavior in the agentbox container (see [[claude-code-container-tui-verify]] -- launch the loader TUI without hanging on the proxy daemon). Manual checks:
- Open the Settings tab (left/right). Confirm a "Global" header with `logConsole` / `logColor`, then one header per plugin that has settings, with that plugin's keys under it.
- Up/Down skips headers and lands only on item rows. Enter on a global item toggles/edits and persists to `config/settings.json`. Enter on a plugin item edits and persists to `config/<name>.json` (verify with `cat`).
- With config-git NOT installed (no `repos/config-git`): the tab still lists global + plugin settings and edits work; the sticky shows the "install config-git for versioning" line; no modified markers.

- [ ] **Step 6: Commit**

```bash
git add src/views/settings.ts src/input.ts src/tui.ts src/state.ts
git commit -m "feat(loader): unified Settings tab (global + all plugins) with config-git preload + markers"
```

---

### Task 4: Git actions -- commit / push / pull + review-gated diff screen

**Files:**
- Create: `src/views/settings-git.ts` (git sub-screen renderers)
- Modify: `src/views/settings.ts` (dispatch to settings-git renderers when in a git sub-mode)
- Modify: `src/input.ts` (`g` opens the git action menu; handle the new modes; add letter keys to `parseKey`)
- Modify: `src/env.ts` (add a `settings` entry to `HELP_BINDINGS`)

**Interfaces:**
- Consumes: `getConfigGit`, `configGitReady`, `configGitInstalled` from `src/config-git.ts`; `refreshSettings` from `src/views/settings.ts`; `flash` from `src/views/common.ts`; format tokens.
- Produces:
  - `buildSettingsGit(pushBody, pushFoot, cols, barW, pushSticky)` in `src/views/settings-git.ts` -- renders whichever git sub-screen is active based on `S.mode` (`sgmenu`, `sgdiff`).
  - New `S.mode` values: `"sgmenu"` (git action menu), `"sgdiff"` (setting-level diff review). New state `S.sgMenuCursor`.
  - `SG_MENU_ITEMS` export (menu definition), reused by the input handler.

- [ ] **Step 1: Add state for the git menu**

In `src/state.ts`, add:

```js
  sgMenuCursor: 0,   // cursor in the config-git action menu
```

- [ ] **Step 2: Add letter keys to the key whitelist**

In `src/input.ts` at the `parseKey` whitelist (line ~888), add the letters `g`, `h`, `p`, `c`, `d`, `P`, `L`, `n` to the actionable-key string if not already present. (Uppercase `P` / `L` distinguish push/pull from lowercase `p` profiles.)

- [ ] **Step 3: Render the git action menu + diff review**

Create `src/views/settings-git.ts` (reuse the file's existing selection-arrow and separator glyphs; ASCII shown here as placeholders):

```ts
// Renderers for the config-git sub-screens reached from the Settings tab:
// the git action menu (sgmenu) and the setting-level diff review (sgdiff).
import { S } from "../state.js";
import { RST, BOLD, DIM, GRAY, WHITE, ACCENT, OK, BAD, INFO, BG_SEL, pad, trunc, rule } from "../format.js";
import { hints } from "./common.js";

export const SG_MENU_ITEMS = [
  { key: "commit", label: "Commit pending changes" },
  { key: "diff", label: "Review changes (diff)" },
  { key: "push", label: "Push to remote" },
  { key: "pull", label: "Pull from remote" },
  { key: "profiles", label: "Profiles / branches" },
  { key: "setup", label: "Repo setup (remote / gh)" },
];

export function buildSettingsGit(pushBody: any, pushFoot: any, cols: number, barW: number, pushSticky: any): void {
  if (S.mode === "sgmenu") {
    pushSticky("  " + BOLD + WHITE + "config-git" + RST);
    pushSticky("");
    for (let i = 0; i < SG_MENU_ITEMS.length; i++) {
      const sel = i === S.sgMenuCursor;
      const arrow = sel ? (ACCENT + " > " + RST) : "   ";
      const bg = sel ? BG_SEL : "";
      const style = sel ? (BOLD + WHITE) : DIM;
      pushBody("  " + bg + arrow + style + SG_MENU_ITEMS[i].label + RST, sel);
    }
    pushFoot("  " + rule(barW));
    pushFoot(hints([["up/down", "move"], ["enter", "select"], ["esc", "back"]]));
    return;
  }
  if (S.mode === "sgdiff") {
    const rows = S.cgDiffRows || [];
    pushSticky("  " + BOLD + WHITE + "Uncommitted changes" + RST + DIM + "  " + rows.length + " setting(s)" + RST);
    pushSticky("");
    if (!rows.length) {
      pushBody("  " + GRAY + "In sync with repo HEAD -- nothing to commit." + RST, false);
    } else {
      let fileW = 6;
      for (const r of rows) fileW = Math.max(fileW, (r.file + " " + r.key).length);
      fileW = Math.min(fileW, Math.max(20, Math.floor(cols * 0.5)));
      for (const r of rows) {
        const label = trunc(r.file + " " + r.key, fileW);
        pushBody("  " + INFO + pad(label, fileW) + RST + "  " + GRAY + r.old + RST + DIM + " -> " + RST + WHITE + r.new + RST, false);
      }
    }
    pushFoot("  " + rule(barW));
    pushFoot(hints([["c", "commit"], ["esc", "back"]]));
    return;
  }
}
```

- [ ] **Step 4: Dispatch the git sub-screens from `buildSettings`**

In `src/views/settings.ts`, near the top of `buildSettings`, before the list-mode rendering, add:

```ts
  if (S.mode === "sgmenu" || S.mode === "sgdiff") {
    buildSettingsGit(pushBody, pushFoot, cols, barW, pushSticky);
    return;
  }
```

Add `import { buildSettingsGit } from "./settings-git.js";` to `settings.ts`. (History/profiles/setup modes are added to this dispatch in Tasks 5-6.)

- [ ] **Step 5: Handle the git keys in `handleSettingsKey`**

In `src/input.ts`, extend `handleSettingsKey`. Add handling for the git sub-modes, and in list mode make `g` open the menu. Add imports `import { getConfigGit, configGitInstalled } from "./config-git.js";` (extend the Task-3 import) and `import { SG_MENU_ITEMS } from "./views/settings-git.js";`.

```js
  // --- config-git sub-modes ---
  if (S.mode === "sgmenu") {
    var items = SG_MENU_ITEMS;
    if (key === "escape" || key === "q" || key === "left") { S.mode = "list"; return; }
    if (key === "up" || key === "w") { S.sgMenuCursor = Math.max(0, S.sgMenuCursor - 1); return; }
    if (key === "down" || key === "s") { S.sgMenuCursor = Math.min(items.length - 1, S.sgMenuCursor + 1); return; }
    if (key === "enter" || key === "space") { runGitMenuAction(items[S.sgMenuCursor].key); return; }
    return;
  }
  if (S.mode === "sgdiff") {
    if (key === "escape" || key === "q" || key === "left") { S.mode = "list"; return; }
    if (key === "c") {
      var m = getConfigGit();
      try { var made = m.autoCommit("manual"); flash(made ? "Committed." : "Nothing to commit."); }
      catch (e) { flash("Commit failed: " + ((e && e.message) || e)); }
      refreshSettings(); S.mode = "list"; return;
    }
    return;
  }
```

Add the `g` handler in the list-mode section (after the enter handler from Task 3):

```js
  if (key === "g" && configGitReady()) { S.mode = "sgmenu"; S.sgMenuCursor = 0; return; }
  if (key === "g" && configGitInstalled() && !configGitReady()) { runGitMenuAction("setup"); return; }
```

Add the `runGitMenuAction` helper in `input.ts` (near `handleSettingsKey`):

```js
function runGitMenuAction(action) {
  var m = getConfigGit();
  if (!m) { flash("config-git not installed."); S.mode = "list"; return; }
  if (action === "commit") {
    try { var made = m.autoCommit("manual"); flash(made ? "Committed." : "Nothing to commit."); }
    catch (e) { flash("Commit failed: " + ((e && e.message) || e)); }
    refreshSettings(); S.mode = "list"; return;
  }
  if (action === "diff") {
    try { S.cgDiffRows = m.diffAgainstHead() || []; } catch { S.cgDiffRows = []; }
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
    refreshSettings(); S.mode = "list"; return;
  }
  // "profiles" and "setup" are wired in Task 6 (leave a friendly stub until then)
  flash("Not available yet."); S.mode = "list";
}
```

- [ ] **Step 6: Add the `settings` help bindings**

In `src/env.ts`, add a `settings` key to `HELP_BINDINGS` (mirror the `plugins` entry's shape) with the actual bindings:

```js
  settings: [
    ["up / down / w / s", "move between settings"],
    ["enter", "edit / toggle a setting"],
    ["g", "config-git actions (commit / push / pull / diff)"],
    ["h", "history of the selected setting"],
    ["p", "switch profile (branch)"],
    ["left / right", "switch tabs"],
    ["q", "quit"],
  ],
```

- [ ] **Step 7: Build and manually verify git actions**

Run: `cd F:/Documents/GitHub/javascript/libs/core-loader && npm run build`
Expected: clean build.

Manual verification (config-git installed + repo initialized, with a local bare remote for push/pull):
- Edit a setting -> the modified marker appears on that row and the sticky shows "N uncommitted".
- Press `g` -> the git menu opens. Select "Review changes" -> the diff screen lists `file key: old -> new`. Press `c` -> commits; markers clear; sticky shows "clean".
- `g` -> "Push" flashes the push result message; "Pull" flashes the pull result and refreshes.
- `?` on the Settings tab now shows the settings help bindings (previously empty -- `env.ts` had no `settings` key).

- [ ] **Step 8: Commit**

```bash
git add src/views/settings-git.ts src/views/settings.ts src/input.ts src/env.ts src/state.ts
git commit -m "feat(loader): config-git commit/push/pull + review-gated diff screen in Settings"
```

---

### Task 5: Per-key history + rollback

**Files:**
- Modify: `src/views/settings-git.ts` (history sub-screen renderer)
- Modify: `src/views/settings.ts` (dispatch `sghistory`)
- Modify: `src/input.ts` (`h` opens history for the selected item; enter rolls back)

**Interfaces:**
- Consumes: `getConfigGit`, `configGitReady`; `S.cgHistory` / `S.cgHistoryFile` / `S.cgHistoryKey` / `S.cgHistoryCursor` (added in Task 1).
- Produces: `S.mode === "sghistory"`; history rows from `keyHistory(file,key)` returning `[{hash,date,value}]`.

- [ ] **Step 1: Render the history sub-screen**

In `src/views/settings-git.ts`, add a branch to `buildSettingsGit`:

```ts
  if (S.mode === "sghistory") {
    pushSticky("  " + BOLD + WHITE + "History" + RST + DIM + "  " + S.cgHistoryFile + " " + S.cgHistoryKey + RST);
    pushSticky("");
    const hist = S.cgHistory || [];
    if (!hist.length) {
      pushBody("  " + GRAY + "No recorded history for this setting." + RST, false);
    } else {
      for (let i = 0; i < hist.length; i++) {
        const h = hist[i];
        const sel = i === S.cgHistoryCursor;
        const arrow = sel ? (ACCENT + " > " + RST) : "   ";
        const bg = sel ? BG_SEL : "";
        const val = (h.value === undefined || h.value === null) ? "(unset)" : JSON.stringify(h.value);
        pushBody("  " + bg + arrow + DIM + String(h.date) + RST + bg + "  " + GRAY + String(h.hash).slice(0, 7) + RST + bg + "  " + WHITE + trunc(val, Math.max(20, cols - 40)) + RST, sel);
      }
    }
    pushFoot("  " + rule(barW));
    pushFoot(hints([["up/down", "move"], ["enter", "roll back to this value"], ["esc", "back"]]));
    return;
  }
```

- [ ] **Step 2: Dispatch `sghistory` from `buildSettings`**

In `src/views/settings.ts`, extend the git-sub-mode dispatch guard added in Task 4 to include `"sghistory"`:

```ts
  if (S.mode === "sgmenu" || S.mode === "sgdiff" || S.mode === "sghistory") {
    buildSettingsGit(pushBody, pushFoot, cols, barW, pushSticky);
    return;
  }
```

- [ ] **Step 3: Handle `h` (open history) and rollback**

In `src/input.ts` `handleSettingsKey`, add to list mode (near the `g` handler):

```js
  if (key === "h" && configGitReady()) {
    var hrow = S.settingsRows[S.settingsCursor];
    if (hrow && hrow.type === "item") {
      var hm = getConfigGit();
      S.cgHistoryFile = hrow.file;
      S.cgHistoryKey = hrow.item.key;
      try { S.cgHistory = hm.keyHistory(hrow.file, hrow.item.key) || []; } catch { S.cgHistory = []; }
      S.cgHistoryCursor = 0;
      S.mode = "sghistory";
    }
    return;
  }
```

Add the `sghistory` sub-mode handler (beside the `sgdiff` handler):

```js
  if (S.mode === "sghistory") {
    if (key === "escape" || key === "q" || key === "left") { S.mode = "list"; return; }
    if (key === "up" || key === "w") { S.cgHistoryCursor = Math.max(0, S.cgHistoryCursor - 1); return; }
    if (key === "down" || key === "s") { S.cgHistoryCursor = Math.min((S.cgHistory.length || 1) - 1, S.cgHistoryCursor + 1); return; }
    if ((key === "enter" || key === "space") && S.cgHistory[S.cgHistoryCursor]) {
      var hh = S.cgHistory[S.cgHistoryCursor];
      var rm = getConfigGit();
      try { rm.rollbackKey(S.cgHistoryFile, S.cgHistoryKey, hh.hash); flash("Rolled back " + S.cgHistoryKey + " to " + String(hh.hash).slice(0, 7)); }
      catch (e) { flash("Rollback failed: " + ((e && e.message) || e)); }
      refreshSettings(); S.mode = "list"; return;
    }
    return;
  }
```

- [ ] **Step 4: Build and manually verify history + rollback**

Run: `cd F:/Documents/GitHub/javascript/libs/core-loader && npm run build`
Expected: clean build.

Manual verification (config-git repo with >= 2 commits changing one setting):
- Select a setting that has changed over time, press `h` -> history lists date, short-hash, value per change.
- Enter on an older entry -> `rollbackKey` writes the old value back, auto-commits, the flash confirms, and the list shows the reverted value.
- `h` on a setting with no history shows the "No recorded history" line.

- [ ] **Step 5: Commit**

```bash
git add src/views/settings-git.ts src/views/settings.ts src/input.ts
git commit -m "feat(loader): per-setting history + rollback in Settings tab"
```

---

### Task 6: Profiles picker + repo setup

**Files:**
- Modify: `src/views/settings-git.ts` (profiles + setup sub-screen renderers)
- Modify: `src/views/settings.ts` (dispatch `sgprofiles`, `sgsetup`)
- Modify: `src/input.ts` (`p` opens profiles; menu "setup"; input sub-modes for new-profile name and remote URL)
- Modify: `src/tui.ts` (`onData` routes the new text-input modes)
- Modify: `src/state.ts` (add `sgSetupCursor`, `_sgSetupOpts`)

**Interfaces:**
- Consumes: `getConfigGit`, `configGitInstalled`, `configGitReady`; `profiles.{list,current,create,switchTo}`, `setup.{initAndSeed,setRemote,ghAvailable,ghCreatePrivate}`, `repo.setRemote`.
- Produces: `S.mode` values `"sgprofiles"`, `"sgsetup"`, and text-input modes `"sgprofinput"` (new profile name), `"sgurlinput"` (remote URL). Export `handleSettingsGitInputData(str)` from `src/input.ts`.

- [ ] **Step 1: Add setup-menu state**

In `src/state.ts`, add:

```js
  sgSetupCursor: 0,
  _sgSetupOpts: [],   // setup-screen options stashed by the renderer for the input handler
```

- [ ] **Step 2: Render profiles + setup sub-screens**

In `src/views/settings-git.ts`, add branches to `buildSettingsGit` (reuse the file's existing cursor glyph; the trailing `|` after the input buffer is a simple caret):

```ts
  if (S.mode === "sgprofiles" || S.mode === "sgprofinput") {
    pushSticky("  " + BOLD + WHITE + "Profiles" + RST + DIM + "  branches of the config repo" + RST);
    pushSticky("");
    const profs = S.cgProfiles || [];
    for (let i = 0; i < profs.length; i++) {
      const sel = i === S.cgProfileCursor && S.mode === "sgprofiles";
      const arrow = sel ? (ACCENT + " > " + RST) : "   ";
      const bg = sel ? BG_SEL : "";
      const cur = profs[i] === S.cgProfileCurrent ? (OK + " (current)" + RST) : "";
      pushBody("  " + bg + arrow + (sel ? BOLD + WHITE : DIM) + profs[i] + RST + cur, sel);
    }
    if (S.mode === "sgprofinput") {
      pushBody("", false);
      pushBody("  " + INFO + "New profile name: " + RST + WHITE + (S.inputBuf || "") + RST + ACCENT + "|" + RST, false);
    }
    pushFoot("  " + rule(barW));
    pushFoot(S.mode === "sgprofinput"
      ? hints([["enter", "create + switch"], ["esc", "cancel"]])
      : hints([["up/down", "move"], ["enter", "switch (review import)"], ["n", "new profile"], ["esc", "back"]]));
    return;
  }
  if (S.mode === "sgsetup" || S.mode === "sgurlinput") {
    const m = S.CONFIG_GIT_MODULE;
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
      const arrow = sel ? (ACCENT + " > " + RST) : "   ";
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
      : hints([["up/down", "move"], ["enter", "select"], ["esc", "back"]]));
    return;
  }
```

- [ ] **Step 3: Dispatch the new modes from `buildSettings`**

In `src/views/settings.ts`, extend the guard:

```ts
  if (S.mode === "sgmenu" || S.mode === "sgdiff" || S.mode === "sghistory" ||
      S.mode === "sgprofiles" || S.mode === "sgprofinput" || S.mode === "sgsetup" || S.mode === "sgurlinput") {
    buildSettingsGit(pushBody, pushFoot, cols, barW, pushSticky);
    return;
  }
```

- [ ] **Step 4: Wire profiles + setup actions into the menu and list**

In `src/input.ts`, replace the `runGitMenuAction` stubs for `"profiles"` and `"setup"`:

```js
  if (action === "profiles") { openProfiles(); return; }
  if (action === "setup") { S.mode = "sgsetup"; S.sgSetupCursor = 0; return; }
```

Add `openProfiles` and the `p` list-mode shortcut:

```js
function openProfiles() {
  var m = getConfigGit();
  try { S.cgProfiles = m.profiles.list() || []; } catch { S.cgProfiles = []; }
  try { S.cgProfileCurrent = m.profiles.current() || ""; } catch { S.cgProfileCurrent = ""; }
  S.cgProfileCursor = Math.max(0, S.cgProfiles.indexOf(S.cgProfileCurrent));
  S.mode = "sgprofiles";
}
```

In list mode (near the `h` handler): `if (key === "p" && configGitReady()) { openProfiles(); return; }`

Add the `sgprofiles` and `sgsetup` mode handlers in `handleSettingsKey`:

```js
  if (S.mode === "sgprofiles") {
    if (key === "escape" || key === "q" || key === "left") { S.mode = "list"; return; }
    if (key === "up" || key === "w") { S.cgProfileCursor = Math.max(0, S.cgProfileCursor - 1); return; }
    if (key === "down" || key === "s") { S.cgProfileCursor = Math.min((S.cgProfiles.length || 1) - 1, S.cgProfileCursor + 1); return; }
    if (key === "n") { S.inputBuf = ""; S.mode = "sgprofinput"; return; }
    if ((key === "enter" || key === "space") && S.cgProfiles[S.cgProfileCursor]) {
      var pm = getConfigGit();
      try { pm.profiles.switchTo(S.cgProfiles[S.cgProfileCursor]); } catch (e) { flash("Switch failed: " + ((e && e.message) || e)); S.mode = "list"; return; }
      // review-gated import: show the diff of the switched-to branch vs live; commit/import stays manual
      try { S.cgDiffRows = pm.diffAgainstHead() || []; } catch { S.cgDiffRows = []; }
      flash("Switched to " + S.cgProfiles[S.cgProfileCursor] + " -- review from the diff screen");
      S.mode = "sgdiff"; return;
    }
    return;
  }
  if (S.mode === "sgsetup") {
    var opts = S._sgSetupOpts || [];
    if (key === "escape" || key === "q" || key === "left") { S.mode = "list"; return; }
    if (key === "up" || key === "w") { S.sgSetupCursor = Math.max(0, S.sgSetupCursor - 1); return; }
    if (key === "down" || key === "s") { S.sgSetupCursor = Math.min(opts.length - 1, S.sgSetupCursor + 1); return; }
    if (key === "enter" || key === "space") { runSetupAction(opts[S.sgSetupCursor] && opts[S.sgSetupCursor].key); return; }
    return;
  }
```

Add `runSetupAction`:

```js
function runSetupAction(action) {
  var m = getConfigGit();
  if (!m) { flash("config-git not installed."); S.mode = "list"; return; }
  if (action === "init") {
    try { m.setup.initAndSeed(); flash("Repo initialized + seeded."); }
    catch (e) { flash("Init failed: " + ((e && e.message) || e)); }
    refreshSettings(); S.mode = "list"; return;
  }
  if (action === "remote") { S.inputBuf = ""; S.mode = "sgurlinput"; return; }
  if (action === "gh") {
    try {
      var r = m.setup.ghCreatePrivate("config-git-" + (process.env.HUB_APP || "loader"));
      flash(r && r.ok ? ("Created + set remote: " + r.url) : ("gh failed: " + (r && r.message)));
    } catch (e) { flash("gh failed: " + ((e && e.message) || e)); }
    refreshSettings(); S.mode = "list"; return;
  }
  flash("Unknown setup action."); S.mode = "list";
}
```

- [ ] **Step 5: Route the new text-input modes in `onData`**

In `src/tui.ts` `onData` (the raw-stdin router at `tui.ts:289-329`), the text-input modes are dispatched to `handle*InputData` before `parseKey`. Add `sgprofinput` and `sgurlinput` to that dispatch, delegating to a new `handleSettingsGitInputData(str)`:

```js
    } else if (S.mode === "sgprofinput" || S.mode === "sgurlinput") {
      handleSettingsGitInputData(str);
```

Add `handleSettingsGitInputData` in `src/input.ts` (mirror the existing `handleConfigInputData` char-accumulation pattern at `input.ts:1129-1145` -- printable chars append to `S.inputBuf`, Backspace pops, Enter commits, Esc cancels). Control bytes: Enter is carriage-return/newline, Esc is 0x1b, Backspace is 0x7f (DEL) or 0x08. Use `String.fromCharCode` so no raw control bytes appear in source:

```js
const KEY_ENTER_CR = String.fromCharCode(13), KEY_ENTER_LF = String.fromCharCode(10);
const KEY_ESC = String.fromCharCode(27), KEY_DEL = String.fromCharCode(127), KEY_BS = String.fromCharCode(8);

export function handleSettingsGitInputData(str) {
  var m = getConfigGit();
  if (str === KEY_ENTER_CR || str === KEY_ENTER_LF) {   // Enter -- commit
    var val = (S.inputBuf || "").trim();
    if (S.mode === "sgprofinput") {
      if (val) { try { m.profiles.create(val); m.profiles.switchTo(val); flash("Created profile " + val); } catch (e) { flash("Create failed: " + ((e && e.message) || e)); } }
      S.mode = "list"; refreshSettings();
    } else { // sgurlinput
      if (val) { try { m.setup.setRemote(val); flash("Remote set: " + val); } catch (e) { flash("Set remote failed: " + ((e && e.message) || e)); } }
      S.mode = "sgsetup";
    }
    S.inputBuf = ""; render(); return;
  }
  if (str === KEY_ESC) { S.inputBuf = ""; S.mode = (S.mode === "sgurlinput") ? "sgsetup" : "list"; render(); return; }   // Esc
  if (str === KEY_DEL || str === KEY_BS) { S.inputBuf = (S.inputBuf || "").slice(0, -1); render(); return; }             // Backspace
  if (str >= " ") { S.inputBuf = (S.inputBuf || "") + str; render(); return; }                                              // printable
}
```

Ensure `render` is imported/available in `input.ts` (the other `handle*InputData` functions already call it).

- [ ] **Step 6: Build and manually verify profiles + setup**

Run: `cd F:/Documents/GitHub/javascript/libs/core-loader && npm run build`
Expected: clean build.

Manual verification:
- With config-git installed but the repo NOT initialized: the Settings sticky prompts to press `g`; `g` runs setup. "Initialize + seed" creates `repos/config-git-data`; the tab then shows branch/remote in the sticky.
- Setup -> "Set remote URL..." accepts a pasted URL and saves it (verify with `git -C repos/config-git-data remote -v`). If `gh` is installed, the "Create private GitHub repo" option appears and creates + sets the remote.
- `p` -> profiles lists branches with the current one marked. "n" creates a new profile (branch) and switches. Enter on another profile switches and drops into the diff-review screen (review-gated import).

- [ ] **Step 7: Commit**

```bash
git add src/views/settings-git.ts src/views/settings.ts src/input.ts src/tui.ts src/state.ts
git commit -m "feat(loader): config-git profiles picker + repo setup (remote/gh) in Settings"
```

---

### Task 7: Build, propagate, deploy, verify

**Files:**
- Modify: `loaders/claude-code-loader` (submodule bump) -- version bump only
- Modify: `loaders/opencode-loader` (submodule bump) -- version bump only

**Interfaces:** none (integration + release task).

- [ ] **Step 1: Run the full test suite + build core-loader**

Run:
```bash
cd F:/Documents/GitHub/javascript/libs/core-loader
npm run build
node test/selection.test.mjs && node test/config-git.test.mjs && node test/settings-model.test.mjs
```
Expected: build clean; all three print `... OK`.

- [ ] **Step 2: Commit + push core-loader**

```bash
cd F:/Documents/GitHub/javascript/libs/core-loader
git add -A && git commit -m "feat: git-aware unified Settings tab (config-git Phase 2)"
git push origin "$(git rev-parse --abbrev-ref HEAD)"
```

- [ ] **Step 3: Bump the core-loader submodule pointer in both loaders**

For each of `loaders/claude-code-loader` and `loaders/opencode-loader`:
```bash
cd F:/Documents/GitHub/javascript/loaders/<loader>
git -C core-loader fetch origin && git -C core-loader reset --hard origin/<default-branch>   # advance submodule to the new core-loader HEAD
git add core-loader
git commit -m "chore: bump core-loader -> <sha7> (config-git unified Settings tab)"
git push origin "$(git rev-parse --abbrev-ref HEAD)"
```
(Replace `<default-branch>` with the loader's core-loader submodule branch and `<sha7>` with the new core-loader short SHA.)

- [ ] **Step 4: Redeploy both app homes**

For the Claude home (`~/.claude/repos/claude-code-loader`) and the opencode home (`~/.config/opencode/repos/opencode-loader`), follow [[deployed-clone-rebuild-recipe]]:
```bash
cd <deployed-clone>
git fetch origin && git reset --hard origin/<default-branch>
git submodule update --init --recursive
git submodule foreach --recursive 'git reset --hard'
npm install
npm run build
```
Confirm `core-loader/dist/config-git.js` and `core-loader/dist/settings-model.js` exist in each deployed clone.

- [ ] **Step 5: End-to-end manual verification in agentbox**

Launch the loader TUI in the agentbox container (per [[claude-code-container-tui-verify]]) with config-git installed via plugin-updater (it is in `OFFICIAL_PLUGINS`). Verify the full flow end-to-end: unified list (global + plugins), edit -> marker, `g` commit/diff/push/pull, `h` history/rollback, `p` profiles switch (with review), setup screen. Then verify the graceful-degradation path: with config-git uninstalled, the tab still lists and edits global + plugin settings with no git chrome.

- [ ] **Step 6: Update the config-git memory pointer**

Flip the Phase 2 line in `C:\Users\finn\.claude\projects\F--Documents-GitHub\memory\config-git-plugin.md` from "DEFERRED" to "DONE" with the delivered features. (Memory file, outside the repo -- no code commit.)

---

## Notes for the executor

- **Probe cost:** `buildPluginSections` runs `node <bundle> config schema` (8s timeout) once per plugin, cached on `S.pluginItems[i]._cfg`. If the Plugins tab already probed a plugin, that cache is reused. Entering the Settings tab the first time may pause briefly while probing; this is acceptable for v1 (documented). Do not add per-plugin async spinners in this phase.
- **Sync push/pull block the event loop** (config-git lib is synchronous). The "Pushing.../Pulling..." flash is drawn before the call, but the screen will not animate during the git subprocess. Acceptable for v1.
- **Do not re-implement config-git logic in the loader.** Every git/diff/history/profile operation goes through the imported lib. The loader owns only navigation, rendering, and the "hide when absent" guard.
- **Glyphs:** the ASCII arrows/markers in the code samples (` > `, ` * `, `->`, `|`) are placeholders. Match the exact selection-arrow and marker glyphs the existing `views/settings.ts` and `views/plugins.ts` already use so the new screens are visually consistent with the rest of the TUI.
