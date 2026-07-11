# config-git — git-backed config management (PARKED, pre-implementation)

Status: design agreed in brainstorming on 2026-07-11; implementation deliberately
deferred (opencode-loader parity work runs first). Resume by reviewing this spec,
then invoke writing-plans.

## Purpose

One feature serving three goals equally: multi-machine/container sync of the
loader-ecosystem configuration, versioned backup with history/rollback, and
shareable profiles (dotfiles-style presets).

## Decisions (user-confirmed)

- **Per-app repo**: one git repo per app home (`~/.claude`, `~/.config/opencode`),
  not a combined repo.
- **Secrets are the user's choice per repo**: `secrets: "exclude" | "include"`.
  Exclude (default) uses a built-in denylist (`accounts.json`, `auth.json`,
  caches) plus field-level stripping of known secret keys inside shareable
  configs (e.g. `leaderboard.apiKey`). Include is for private repos; warn on
  enable. Private and public/shared repos are equally supported.
- **Cadence**: auto-commit every local config change (clean history); push and
  pull are always manual TUI actions gated by a setting-level visual diff.
- **v1 visual scope (all four)**: setting-level diff (plugin · key · old → new),
  git-aware unified Settings tab, per-setting history + rollback, and a
  profiles/branches picker.
- **Packaging**: standalone dual-app plugin `config-git` (sync-bridge /
  plugin-updater pattern): owns git ops + diff/history logic, ships
  `dist/lib.js` for the loaders and a CLI for headless use.
- **Repo setup**: plugin inits the local repo and seeds it from current config;
  remote is a pasted URL; when `gh` is installed+authed, offer a
  "create private repo now" shortcut. No hard GitHub dependency.

## Architecture (approach A — shadow repo + reconcile)

Chosen over git-in-place because field-level secret stripping, review-gated
pulls, and safe profile switching all require a mapping layer; the live
`config/` never gains a `.git`.

- Working repo at `<home>/repos/config-git-data` (per app home) holding
  sanitized snapshots of `config/*.json` + `plugins.json`.
- **Export** (live → repo): copy tracked files, apply secrets mode
  (drop denylisted files, strip secret fields). Runs on plugin load
  (auto-commit) and after every Settings-tab edit.
- **Import** (repo → live): apply repo state to live config only after the user
  approves the setting-level diff. Applying writes whole config files (same
  license sync-bridge has as a config-file manager).
- **Diff model**: load JSON at HEAD (`git show`) vs live sanitized view,
  flatten keys, emit `{plugin, key, old, new}` rows — never raw text diffs.
- **History**: `git log` per file; per-key timeline extracted by loading the
  file at each commit. Rollback writes the old value back and auto-commits.
- **Profiles**: branches of the same repo. Switching = checkout in the shadow
  repo + review-gated import. Named profiles listed in the picker.

## Loader integration (delegation contract)

core-loader owns a new unified **Settings tab**: global settings + every
plugin's settings via the existing `node <bundle> config schema` probing —
works with plain editing even when config-git is absent. When
`repos/config-git/dist/lib.js` exists, the tab lights up git features:
modified-vs-repo markers, commit/push/pull with diff review, history, profile
picker. Same "loader delegates to the plugin, hides features when absent" rule
as plugin-updater. Loaders stay provider-agnostic; only the generic lib
contract is consumed.

## Error handling / constraints

- All git ops via the git CLI (plugin-updater precedent); no native deps.
- Conflicts: pull rebases the shadow repo; on conflict, the setting-level diff
  shows both sides and the user picks per key (union write, then commit).
- Never touch live config without an approved diff (except auto-commit, which
  only reads live state).
- Repo missing/corrupt → features disabled with a clear notice; plain settings
  editing keeps working.

## Testing

- vitest + contract kit (`runPluginContract`) in isolated temp homes.
- Unit: sanitizer (denylist + field stripping), flatten/diff, merge-on-conflict.
- Integration: init → seed → edit → auto-commit → diff → push to a local bare
  remote → clone into a second temp home → import with review → identical
  effective config (minus secrets).

## Open items for the implementation plan

- Exact tracked-file list + per-plugin secret-field registry (start with a
  static map in config-git; plugins can later declare secret keys in their
  config schema).
- Settings-tab UX details (marker glyphs, key nav) — follow existing tab
  conventions.
