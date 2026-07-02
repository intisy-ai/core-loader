# Loader Delegates Git Plugins to the Updater — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the loader rely 100% on plugin-updater for git plugins — detect the updater reliably (no Bun auto-install false positive), gate the git section on it, remove the phantom engine row, add a dual (git/npm) marketplace install with git preferred, and give npm plugins management parity.

**Architecture:** All changes are in the shared `core-loader` submodule (bundled into both loaders). `loadPlugins()` already sources the list from `updater.getPlugins()`; the linchpin fix is `getUpdater()` detection. Then UI/flow changes build on that. Both loaders pick it up via a submodule bump + rebuild.

**Tech Stack:** TypeScript (`@ts-nocheck` legacy TUI modules), Bun (TUI runtime), Node (proxy/updater), vitest (unit tests), Docker agentbox for in-container verification.

## Global Constraints

- TypeScript only; never commit `dist/`.
- Never override git identity (finn@birich.de); Conventional Commits.
- Default-branch pushes need explicit user OK.
- Minimal comments — non-obvious logic only.
- Fix both loaders together via the `core-loader` submodule (bump pointer in each).
- The updater is installed only by explicit user action — never automatically.
- Verify TUI behavior in the running agentbox container (`docker ps` → image `agentbox:local`); TUI rendering is not unit-testable, so those steps verify in-container with exact commands.

---

### Task 1: Path-only updater detection (kill the Bun auto-install false positive)

**Files:**
- Modify: `core-loader/src/updater.ts` (`getUpdater`, ~lines 11-44)

**Interfaces:**
- Produces: `getUpdater()` returns a module ONLY when resolved via a real candidate path (so `S.UPDATER_PATH` is always set on success); returns `null` otherwise. Consumed by `loadPlugins()` (config.ts), `buildPlugins` gate (views/plugins.ts), and every action in input.ts.

- [ ] **Step 1: Remove the bare-require fallback**

In `getUpdater()`, delete the fallback block that resolves without a path:

```js
  // DELETE these lines (the only branch Bun auto-install can hijack):
  try {
    S.UPDATER_MODULE = require("plugin-updater");
    return S.UPDATER_MODULE;
  } catch {}
```

So the function ends, after the candidate-path loop, with:

```js
  S.UPDATER_MODULE = null;
  return null;
}
```

- [ ] **Step 2: Verify the gate now fires under Claude (in-container)**

Rebuild core-loader and deploy just this file, then check `getUpdater()` resolves to null when no real updater exists:

Run:
```bash
cd F:/Documents/GitHub/javascript/loaders/claude-code-loader/core-loader && npx tsc
CID=$(docker ps -q --filter ancestor=agentbox:local | head -1)
docker cp core-loader/dist/updater.js $CID:/root/.claude/repos/claude-code-loader/core-loader/dist/updater.js
docker exec $CID bash -lc 'cd ~/.claude/repos/claude-code-loader/core-loader/dist && command -v bun >/dev/null && bun -e "const {getUpdater}=require(\"./updater.js\"); console.log(\"updater:\", getUpdater()===null?\"null (gate fires)\":\"resolved\")" 2>&1'
```
Expected: `updater: null (gate fires)` (no npx cache / no persistent copy present).

- [ ] **Step 3: Commit**

```bash
cd F:/Documents/GitHub/javascript/loaders/claude-code-loader/core-loader
git add src/updater.ts
git commit -m "fix: resolve updater only via real paths (no bare require)

Bun auto-install satisfied the bare require(\"plugin-updater\") under Claude (no
nearby node_modules), producing a pathless phantom updater: the gate never fired
and the version showed \"not installed\". Detection now requires a resolved
candidate path, so getUpdater() truthy implies UPDATER_PATH is set."
```

---

### Task 2: Remove the phantom engine row + collapse the duplicated gate

**Files:**
- Modify: `core-loader/src/plugins.ts` (`buildCombinedPluginList`, ~lines 128-149)
- Modify: `core-loader/src/views/plugins.ts` (gate, ~lines 79-104)

**Interfaces:**
- Produces: `buildCombinedPluginList()` no longer appends a `plugin-updater` engine row. The Installed tab shows real git + npm plugins only; the updater's availability is expressed solely by the gate.

- [ ] **Step 1: Delete the engine-row push in `buildCombinedPluginList`**

Remove the entire block that pushes the engine row:

```js
  // DELETE this block:
  if (getUpdater() && !npm.some(function(p) { return p.name === "plugin-updater"; })) {
    npm.push({
      type: "npm", engine: true, name: "plugin-updater", version: getUpdaterVersion(),
      raw: "plugin-updater", enabled: true, autoUpdate: true, installed: true,
      deployed: true, updateAvail: false, localHead: "", remoteHead: "",
      latestTag: "", subject: "plugin engine", folderName: "", url: "", hasBuild: false, pluginFile: ""
    });
  }
```

`buildCombinedPluginList` now returns `git.concat(npm)` with no engine row.

- [ ] **Step 2: Collapse the duplicated gate branches in `views/plugins.ts`**

The `CC_LAUNCHER` and `else` branches are byte-identical. Replace the whole `if (!hasUpdater) { if (CC_LAUNCHER) {...} else {...} }` with one branch:

```js
  if (!hasUpdater) {
    pushBody("  " + BOLD + BAD + "Updater Plugin Missing" + RST, false);
    pushBody("  The hub requires an updater plugin to manage installations.", false);
    pushBody("", false);
    pushBody("  Press " + BOLD + WHITE + "Enter" + RST + " to install the default updater plugin.", false);
    pushBody("", false);
    pushFoot("  " + rule(barW));
    pushFoot(hints([["enter", "install"], ["q", "quit"]]));
    S.globalKeyHandler = "updater_install";
    return;
  } else {
    if (S.globalKeyHandler === "updater_install") S.globalKeyHandler = null;
  }
```

- [ ] **Step 3: Verify the gate renders and no engine row appears (in-container)**

Rebuild + deploy the loader; with no updater, the Installed tab shows the gate. Run:
```bash
cd F:/Documents/GitHub/javascript/loaders/claude-code-loader && npm run build
CID=$(docker ps -q --filter ancestor=agentbox:local | head -1)
docker cp core-loader/dist/plugins.js $CID:/root/.claude/repos/claude-code-loader/core-loader/dist/plugins.js
docker cp core-loader/dist/views/plugins.js $CID:/root/.claude/repos/claude-code-loader/core-loader/dist/views/plugins.js
docker exec $CID bash -lc 'grep -c "plugin engine" ~/.claude/repos/claude-code-loader/core-loader/dist/plugins.js'
```
Expected: `0` (engine-row push gone). Full TUI gate render is confirmed in Task 6.

- [ ] **Step 4: Commit**

```bash
cd F:/Documents/GitHub/javascript/loaders/claude-code-loader/core-loader
git add src/plugins.ts src/views/plugins.ts
git commit -m "fix: drop phantom updater engine row; collapse duplicate gate"
```

---

### Task 3: App-aware "install updater" action

**Files:**
- Modify: `core-loader/src/tui.ts` (`updater_install` handler, ~lines 273-300)

**Interfaces:**
- Consumes: `S.globalKeyHandler === "updater_install"`, `CONFIG_DIR`, `APP_NAME`.
- Produces: installs the updater by the app-appropriate mechanism, then refreshes the list.

- [ ] **Step 1: Replace the opencode-only install body with an app-aware one**

Current code always runs `npm install -g plugin-updater` + edits `opencode.json`. Replace the try-block body inside `if (key === "enter" || key === "space")` with:

```js
      process.stdout.write("\x1b[?25h\n\x1b[36mInstalling updater plugin...\x1b[0m\n");
      try {
        const { execSync } = require('child_process');
        const fs = require('fs');
        const path = require('path');
        if (APP_NAME === "Claude Code") {
          // Claude uses the transient npx engine via the SessionStart hook; register it.
          const settingsPath = path.join(CONFIG_DIR, "settings.json");
          let settings = {};
          try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch {}
          const hooks = settings.hooks || (settings.hooks = {});
          const sessionStart = hooks.SessionStart || (hooks.SessionStart = []);
          if (!JSON.stringify(sessionStart).includes("plugin-updater")) {
            sessionStart.push({ hooks: [{ type: "command", command: "npx -y plugin-updater@latest run --app claude" }] });
          }
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
        } else {
          execSync("npm install -g plugin-updater", { stdio: "inherit" });
          const ocPath = path.join(CONFIG_DIR, "opencode.json");
          let ocData = {};
          if (fs.existsSync(ocPath)) {
            try { ocData = JSON.parse(fs.readFileSync(ocPath, "utf-8").replace(/^\s*\/\/[^\n]*/gm, "")); } catch {}
          }
          if (!Array.isArray(ocData.plugin)) ocData.plugin = [];
          if (!ocData.plugin.includes("plugin-updater")) ocData.plugin.unshift("plugin-updater");
          fs.writeFileSync(ocPath, JSON.stringify(ocData, null, 2), "utf-8");
        }
      } catch(e) {
        tuiLog("Failed to install updater: " + e.message);
        flash("Failed to install updater: " + e.message);
      }
      S.globalKeyHandler = null;
      S.hasUpdater = false;   // re-detect on next render (Claude: only real after next launch populates npx cache)
      S.pluginItems = buildCombinedPluginList();
      render();
```

- [ ] **Step 2: Verify `APP_NAME` is imported in tui.ts**

Run: `grep -n "APP_NAME" F:/Documents/GitHub/javascript/loaders/claude-code-loader/core-loader/src/tui.ts | head -1`
Expected: an import or usage line. If absent, add `APP_NAME` to the existing `import { ... } from "./env.js";`.

- [ ] **Step 3: Verify Claude install registers the hook (in-container)**

```bash
cd F:/Documents/GitHub/javascript/loaders/claude-code-loader && npm run build
CID=$(docker ps -q --filter ancestor=agentbox:local | head -1)
docker cp core-loader/dist/tui.js $CID:/root/.claude/repos/claude-code-loader/core-loader/dist/tui.js
docker exec $CID bash -lc 'node -e "const s=require(process.env.HOME+\"/.claude/settings.json\"); console.log(JSON.stringify(s.hooks.SessionStart).includes(\"plugin-updater\")?\"hook present\":\"hook MISSING\")"'
```
Expected: `hook present` (already registered in agentbox; the handler is idempotent — it won't duplicate).

- [ ] **Step 4: Commit**

```bash
cd F:/Documents/GitHub/javascript/loaders/claude-code-loader/core-loader
git add src/tui.ts
git commit -m "feat: app-aware updater install (Claude: SessionStart hook; OpenCode: npm)"
```

---

### Task 4: Marketplace dual install with git preferred

**Files:**
- Modify: `core-loader/src/marketplace.ts` (`installMarketplacePlugin`, ~lines 443-460; add `selectInstallMethod`)
- Modify: `core-loader/src/views/plugins.ts` (marketplace action affordance)
- Modify: `core-loader/src/input.ts` (marketplace install action wiring)
- Test: `core-loader/src/__tests__/install-method.test.ts` (new)

**Interfaces:**
- Produces:
  - `selectInstallMethod(entry, hasUpdater): "git" | "npm"` — pure. Rule: `hasUpdater && entry.install !== "npm"` → `"git"`; else `"npm"`.
  - `installViaUpdater(entry, done)` — registers the entry and runs the updater (module API or transient npx `add`); replaces the loader's own `git clone` + `savePlugins`.
  - `installViaNpm(entry, done)` — `updater.installNpmPlugin` when loaded, else `npm install -g` + opencode.json (OpenCode).
- Consumes: `getUpdater()`, `S.hasUpdater`.

- [ ] **Step 1: Write the failing unit test for `selectInstallMethod`**

Create `core-loader/src/__tests__/install-method.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { selectInstallMethod } from "../marketplace.js";

describe("selectInstallMethod", () => {
  it("prefers git when the updater is available and no npm hint", () => {
    expect(selectInstallMethod({ name: "x" }, true)).toBe("git");
  });
  it("honors an explicit npm hint even when the updater is available", () => {
    expect(selectInstallMethod({ name: "x", install: "npm" }, true)).toBe("npm");
  });
  it("falls back to npm when the updater is unavailable", () => {
    expect(selectInstallMethod({ name: "x" }, false)).toBe("npm");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd F:/Documents/GitHub/javascript/loaders/claude-code-loader/core-loader && npx vitest run src/__tests__/install-method.test.ts`
Expected: FAIL — `selectInstallMethod` is not exported.

- [ ] **Step 3: Implement `selectInstallMethod` in marketplace.ts**

Add near the top of the module (after imports):

```js
export function selectInstallMethod(entry, hasUpdater) {
  if (hasUpdater && entry.install !== "npm") return "git";
  return "npm";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/install-method.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Reroute git install through the updater (no loader-side clone)**

Replace `installMarketplacePlugin`'s body with delegation. New code:

```js
export function installMarketplacePlugin(entry, done) {
  var repoName = entry.repoName || entry.name;
  var url = entry.url;
  var updater = getUpdater();
  if (updater && typeof updater.updatePluginPublic === "function") {
    Promise.resolve(updater.updatePluginPublic(repoName, url)).then(function() { done(null); })
      .catch(function(e) { done("Install failed: " + ((e && e.message) || e)); });
    return;
  }
  // module not loadable yet: drive the transient npx add (the one sanctioned direct npx)
  var app = APP_NAME === "Claude Code" ? "claude" : "opencode";
  exec("npx -y plugin-updater@latest add " + url + " --app " + app, { timeout: 120000 }, function(err) {
    done(err ? ("Install failed: " + ((err && err.message) || err)) : null);
  });
}
```

Add `getUpdater` to the marketplace.ts imports: `import { getUpdater } from "./updater.js";` and keep the existing `exec` import. Remove the now-unused `savePlugins` import if nothing else uses it in this file (check with `grep -n savePlugins src/marketplace.ts`).

- [ ] **Step 6: Add `installViaNpm` for the secondary/fallback method**

```js
export function installViaNpm(entry, done) {
  var name = entry.repoName || entry.name;
  var updater = getUpdater();
  if (updater && typeof updater.installNpmPlugin === "function") {
    try { var e = updater.installNpmPlugin(name, CONFIG_DIR) || ""; done(e || null); }
    catch (err) { done("npm install failed: " + ((err && err.message) || err)); }
    return;
  }
  exec("npm install -g " + name, { timeout: 120000 }, function(err) {
    done(err ? ("npm install failed: " + ((err && err.message) || err)) : null);
  });
}
```

Add `CONFIG_DIR` to the env import if not present (`grep -n CONFIG_DIR src/marketplace.ts`).

- [ ] **Step 7: Wire the default + secondary method in the marketplace install action (input.ts)**

Find the marketplace install action (where `installMarketplacePlugin` is currently called). Choose the method and offer the other as a secondary action:

```js
      var method = selectInstallMethod(mkEntry, S.hasUpdater);
      var install = method === "git" ? installMarketplacePlugin : installViaNpm;
      flash("Installing " + mkEntry.name + " (" + method + ")...");
      render();
      install(mkEntry, function(err) {
        flash(err ? err : (mkEntry.name + " installed (" + method + ")."));
        S.pluginItems = buildCombinedPluginList();
        render();
      });
```

Import `selectInstallMethod` and `installViaNpm` in input.ts alongside the existing `installMarketplacePlugin` import.

- [ ] **Step 8: Commit**

```bash
cd F:/Documents/GitHub/javascript/loaders/claude-code-loader/core-loader
git add src/marketplace.ts src/input.ts src/__tests__/install-method.test.ts
git commit -m "feat: marketplace dual install (git preferred via updater, npm fallback)"
```

---

### Task 5: npm plugin management parity (add Configure)

**Files:**
- Modify: `core-loader/src/plugins.ts` (`getPluginActions`, npm branch, ~lines 162-167)
- Modify: `core-loader/src/input.ts` (npm action dispatch)
- Test: `core-loader/src/__tests__/plugin-actions.test.ts` (new)

**Interfaces:**
- Produces: npm plugins expose `update-npm`, `uninstall-npm`, and (when the bundle answers `config schema`) `configure`. Git-only actions stay excluded.

- [ ] **Step 1: Write the failing unit test**

Create `core-loader/src/__tests__/plugin-actions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getPluginActions } from "../plugins.js";

describe("getPluginActions (npm)", () => {
  it("offers update, uninstall, and configure when a config schema is present", () => {
    const item = { type: "npm", name: "x", deployed: true, _cfg: { items: [{ key: "a" }] } };
    const keys = getPluginActions(item).map(a => a.key);
    expect(keys).toContain("update-npm");
    expect(keys).toContain("uninstall-npm");
    expect(keys).toContain("configure");
  });
  it("omits configure when no schema", () => {
    const item = { type: "npm", name: "x", deployed: true };
    expect(getPluginActions(item).map(a => a.key)).not.toContain("configure");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/plugin-actions.test.ts`
Expected: FAIL — `configure` not offered for npm items.

- [ ] **Step 3: Add Configure to the npm branch of `getPluginActions`**

Replace the npm branch:

```js
  if (pitem.type === "npm") {
    var a = [];
    if (pitem._cfg && pitem._cfg.items && pitem._cfg.items.length) {
      a.push({ cat: "Configure", key: "configure", label: "Configure settings (" + pitem._cfg.items.length + ")" });
    }
    a.push({ cat: "Update", key: "update-npm", label: "Update npm plugin" });
    a.push({ cat: "Manage", key: "uninstall-npm", label: "Uninstall npm plugin" });
    a.push({ key: "cancel", label: "Cancel" });
    return a;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/plugin-actions.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Ensure the config schema is probed for npm items too**

Find where `probeConfigSchema` populates `pitem._cfg` before opening the action menu (search input.ts for `probeConfigSchema`). Confirm it runs for `type === "npm"` deployed items; `probeConfigSchema` already returns null for `type === "npm"` (plugins.ts:202) — change that guard to allow npm:

```js
  // plugins.ts probeConfigSchema: allow npm bundles (they are deployed + loadable)
  if (!pitem || !pitem.deployed) return null;
```
(Remove the `pitem.type === "npm"` part of the early return.) The `configure` action reuses the existing config editor (no new handler needed — it keys off `_cfg`).

- [ ] **Step 6: Commit**

```bash
cd F:/Documents/GitHub/javascript/loaders/claude-code-loader/core-loader
git add src/plugins.ts src/input.ts src/__tests__/plugin-actions.test.ts
git commit -m "feat: npm plugin management parity (add Configure)"
```

---

### Task 6: Ship — submodule bump, rebuild both loaders, in-container verification

**Files:**
- Modify: `claude-code-loader` (core-loader submodule pointer)
- Modify: `opencode-loader` (core-loader submodule pointer)

**Interfaces:**
- Consumes: all prior tasks (committed on core-loader `master`).

- [ ] **Step 1: Push core-loader (after user OK) and bump both loaders**

```bash
cd F:/Documents/GitHub/javascript/loaders/claude-code-loader/core-loader
git push origin master
CLSHA=$(git rev-parse HEAD)
cd ../.. && cd opencode-loader && git -C core-loader fetch origin master && git -C core-loader reset --hard "$CLSHA"
cd ../claude-code-loader && npm run build
cd ../opencode-loader && npm run build
```

- [ ] **Step 2: Full run to propagate + verify Claude gate (in-container)**

```bash
CID=$(docker ps -q --filter ancestor=agentbox:local | head -1)
docker exec $CID bash -lc 'rm -rf ~/.bun/install/cache/plugin-updater* 2>/dev/null; true'   # clear the auto-install phantom
# (Manual) launch `cc`, open Plugins tab. Expected: "Updater Plugin Missing" gate, NO plugin list, NO engine row.
```
Expected (manual TUI): the gate shows under Claude exactly like OpenCode; no phantom row.

- [ ] **Step 3: Verify list returns after a real updater exists**

```bash
# (Manual) Press Enter on the gate to register the hook; relaunch cc so the SessionStart npx run populates the updater.
# Then open Plugins: git plugins list; npm plugin rows offer Update / Uninstall / Configure.
```
Expected: git list appears only with a real updater; npm rows have parity actions.

- [ ] **Step 4: Commit the submodule bumps + push (after user OK)**

```bash
cd F:/Documents/GitHub/javascript/loaders/claude-code-loader
git add core-loader && git commit -m "chore: bump core-loader (updater-delegation, gate, marketplace, npm parity)"
git push origin master
cd ../opencode-loader
git add core-loader && git commit -m "chore: bump core-loader (updater-delegation, gate, marketplace, npm parity)"
git push origin main
```

---

## Self-Review

**Spec coverage:**
- A (detection) → Task 1. B (delegation: list already done in config.ts; install rerouted) → Task 4. C (gate + phantom + app-aware install) → Tasks 2, 3. D (marketplace dual/git-preferred) → Task 4. E (npm parity) → Task 5. Ship → Task 6. All covered.

**Placeholder scan:** No TBD/TODO; each code step shows complete code or an exact edit against verbatim current code.

**Type consistency:** `selectInstallMethod(entry, hasUpdater)`, `installViaNpm(entry, done)`, `installMarketplacePlugin(entry, done)` used consistently across Tasks 4 and their input.ts wiring; `getUpdater()` null-contract used consistently in Tasks 1–5.

**Note on testing:** TUI rendering/flows are verified in-container (not unit-testable under bun); pure helpers (`selectInstallMethod`, `getPluginActions`) have vitest tests. This matches the codebase's existing test boundary (vitest scoped to `src/`, contract tests only).
