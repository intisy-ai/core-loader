# Loader delegates git plugins to the updater

Date: 2026-07-02
Status: Approved (design) — pending written-spec review
Repo: core-loader (shared submodule of claude-code-loader + opencode-loader)

## Problem

The loader partly does plugin-updater's job and detects the updater unreliably:

1. **Loader enumerates/installs git plugins itself.** `buildPluginList()` reads
   `plugins.json` directly; `installMarketplacePlugin()` runs its own `git clone`
   and `savePlugins()` writes `plugins.json`. Git plugins must be 100% the
   updater's domain.
2. **Updater detection is a false positive under Claude.** The Plugins tab gates
   on `hasUpdater = !!(getUpdater()?.updatePluginPublic)`. `getUpdater()`'s last
   fallback is a bare `require("plugin-updater")`. The TUI runs under Bun; when no
   `node_modules` is present up-tree (the Claude case), **Bun auto-install** fetches
   plugin-updater from npm to satisfy the bare require, so `hasUpdater` is `true`
   even though nothing is really installed. Under OpenCode a `node_modules`
   (`~/.config/opencode/node_modules`) disables Bun auto-install, the bare require
   fails, and the correct "Updater Plugin Missing" gate shows. Same code, opposite
   behavior — purely from Bun auto-install.
3. **Phantom row.** Because the Claude false positive resolves via the bare require,
   `S.UPDATER_PATH` is never set, so `getUpdaterVersion()` returns `""` and the npm
   section renders `plugin-updater — engine — not installed` beneath a plugin list
   that should not be shown at all.
4. **Marketplace is git-only.** `installMarketplacePlugin()` always clones; there is
   no npm install path and no notion of a default method.

## Requirements (user, restated)

- R1 Git plugins are handled 100% by the updater. The loader must not read/write
  `plugins.json`, clone, or build git plugins itself.
- R2 If the updater is not available, the loader shows no git plugins and relies on
  the updater to even know they exist.
- R3 No phantom updater row; the updater's availability gates the git section.
- R4 Marketplace: plugin-updater has priority; every entry installable via the
  updater (git) or as an npm plugin; the default is git-via-updater (preferred),
  overridable per-plugin. The updater itself is installed only by explicit user
  action (marketplace entry or the Installed-tab gate), never automatically.
- R5 npm plugins get management parity with git plugins (uninstall, update,
  configure where applicable), not just a bare row.

## Design

### A. Reliable detection (`updater.ts`)

`hasUpdater` must mean "a real, path-resolved updater is loadable", never a
Bun-auto-installed phantom.

- `getUpdater()` resolves ONLY via the explicit candidate paths (deployed bundle,
  opencode package cache, `~/.npm/_npx/*` npx cache) — each sets `S.UPDATER_PATH`.
- **Remove the bare `require("plugin-updater")` fallback** (lines that currently do
  `S.UPDATER_MODULE = require("plugin-updater")` with no path). That fallback is the
  only thing Bun auto-install can hijack, and it is the sole source of the false
  positive + the pathless phantom.
- Consequence: `getUpdater()` truthy ⇒ `S.UPDATER_PATH` set ⇒ `getUpdaterVersion()`
  works. Under Claude with no real install (and no npx cache yet) → `null` → gate,
  matching OpenCode. After the SessionStart hook has run (npx cache populated) →
  resolves the npx candidate → real version.

### B. Loader delegates all git-plugin operations (`plugins.ts`, `marketplace.ts`, `input.ts`)

The updater module is the single source of truth for git plugins.

- **List:** git rows come from `updater.getPlugins(configDir)` (already an API),
  not the loader's own `loadPlugins()`. Enrichment (git HEAD/tag/subject) may stay
  in the loader for display, but the set of plugins comes from the updater.
- **Install (marketplace, git route):** call the updater to add + set up the plugin
  instead of `installMarketplacePlugin()`'s direct `git clone` + `savePlugins()`.
  Use the updater API when loaded (`updatePluginPublic` after registering the
  entry), or drive `npx -y plugin-updater@latest add <url> --app <app>` when only
  npx is available (the single sanctioned direct-npx use, matching SessionStart).
- **Update / remove / enable-disable:** already routed through the updater where
  possible; audit `input.ts` so none of these paths fall back to loader-side
  `plugins.json` writes.
- Net removal from the loader: direct `git clone`, `savePlugins()` for git plugins,
  and independent `plugins.json` reads for the authoritative list.

### C. Gate + phantom removal + app-aware install (`views/plugins.ts`, `tui.ts`)

- The existing "Updater Plugin Missing" gate already renders when `!hasUpdater`;
  with fix A it now fires correctly under Claude too. Keep the single gate (the CC
  and OC branches are identical — collapse to one).
- **Remove the npm `plugin-updater — engine` row** from the Installed list
  (`buildCombinedPluginList` engine-row push). The updater is never a managed row.
- **App-aware install action** (`tui.ts` `updater_install` handler): today it does
  `npm install -g plugin-updater` + edits `opencode.json` unconditionally. Make it:
  - Claude → ensure the SessionStart hook (`npx -y plugin-updater@latest run --app
    claude`) is registered in `settings.json`; the hook installs/runs it. No global
    npm install, no opencode.json.
  - OpenCode → keep `npm install -g` (or add to `opencode.json` plugin list).

### D. Marketplace dual install + updater priority (`marketplace.ts`, `views`, `input.ts`)

- Each marketplace entry offers two install methods:
  - **git via updater** (register + updater sets it up), and
  - **npm** (`updater.installNpmPlugin` when loaded, else `npm`/opencode.json).
- **Default method**, in priority order:
  1. **git via updater** when the updater is available (preferred), else
  2. per-entry hint `install: "npm"` forcing npm, else
  3. **npm** when the updater is unavailable.
  The non-default method is a secondary action in the entry's action menu. When the
  updater is unavailable, only npm is offered (plus installing the updater).
- **plugin-updater priority:** it sorts first in the marketplace as the engine.
  Installing it is user-initiated only — via its marketplace entry or the
  Installed-tab gate's Enter (same app-aware action). Never auto-installed.

### E. npm plugin management parity (`plugins.ts` `getPluginActions`, `input.ts`)

npm plugins get an action menu comparable to git plugins, limited to what npm
supports:

- **Uninstall** (exists: `uninstall-npm` → `updater.uninstallNpmPlugin`).
- **Update** (exists: `update-npm`).
- **Configure** — probe the deployed npm bundle with `config schema`
  (`probeConfigSchema` already works on any deployed bundle); show the Configure
  action when the plugin answers.
- Omit git-only actions (downgrade-to-commit, force-rebuild, auto-update toggle),
  which have no npm equivalent.

## Files touched

- `core-loader/src/updater.ts` — drop bare-require fallback; detection via resolved paths only.
- `core-loader/src/plugins.ts` — git list from `updater.getPlugins`; drop the engine-row push; no loader-side git enumeration as source of truth.
- `core-loader/src/marketplace.ts` — replace direct `git clone`/`savePlugins` with updater-driven install; add npm install path; default-method selection.
- `core-loader/src/views/plugins.ts` — collapse the duplicated gate; remove npm engine row rendering; marketplace dual-method action affordances.
- `core-loader/src/input.ts` — route install/update/remove through the updater; wire dual-method marketplace actions.
- `core-loader/src/tui.ts` — app-aware `updater_install` handler.

Both loaders pick this up via the core-loader submodule bump + rebuild.

## Error handling / edge cases

- Updater loads but an operation fails → surface the updater's error via `flash`;
  never silently fall back to loader-side git work.
- Claude pre-first-launch (no npx cache) → `hasUpdater=false` → gate; Enter
  registers the hook; next Claude start populates the updater.
- Installing the updater itself always uses the app-appropriate path (npx/hook for
  Claude, npm for OpenCode) — never a bare require.

## Testing (in-container, both apps)

- Claude: with no real updater → gate shows (no list, no phantom row); Enter
  registers the SessionStart hook. After a run populates the npx cache →
  `getUpdater()` resolves the npx candidate, version shows, git list appears.
- OpenCode: unchanged gate behavior; after installing the updater the list appears.
- Marketplace: an entry installs via git (updater, the default) and via npm (the
  secondary action / when the updater is absent); plugin-updater sorts first and
  installs only on explicit selection.
- npm plugin row: uninstall, update, and configure (when the bundle answers
  `config schema`) all work.
- Regression: `bun` context with no nearby `node_modules` no longer yields a false
  positive (the bug that started this).

## Out of scope

- Changing the transient-npx delivery model for Claude (unchanged).
- MCP tab behavior.
- Marketplace catalog sources/enrichment.

## Resolved defaults (were open questions)

- "Updater available" = `getUpdater()` resolves via a real path (Design A);
  confirmed — drop the bare require, no auto-install rescue.
- Marketplace default = **git via updater when available** (preferred); a per-entry
  `install: "npm"` hint forces npm; npx-only fallback when the module isn't loaded.
- The updater is installed only by explicit user action (marketplace entry or the
  Installed-tab gate) — never automatically.
- npm plugins gain uninstall/update/configure (Design E).
