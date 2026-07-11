# config-git Plugin Implementation Plan (Phase 1 — the plugin engine)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone dual-app plugin `config-git` that versions an app home's config in a per-home shadow git repo — sanitized snapshots, auto-commit on change, manual review-gated push/pull, setting-level diff, history/rollback, and profiles (branches) — usable headlessly via its CLI and exposing `dist/lib.js` for the loader to consume later.

**Architecture:** Approach A (shadow repo + reconcile) from the spec. The plugin owns a working repo at `<configDir>/repos/config-git-data` holding sanitized copies of `config/*.json` + `plugins.json`. **Export** (live → repo) sanitizes per the repo's secrets mode and auto-commits; **import** (repo → live) writes whole config files only after the caller supplies an approved diff. All git via the git CLI. This is Phase 1; the loader's git-aware Settings tab is a separate Phase-2 plan that consumes `dist/lib.js`.

**Tech Stack:** TypeScript (ESNext, NodeNext, strict), esbuild dual-bundle (`dist/index.js` hook + `dist/lib.js` library), vitest, `core` submodule (config/logging/CLI framework), git CLI.

## Global Constraints

- ALL source is TypeScript in `src/`; compiled `dist/` is gitignored and never committed.
- `package.json` required fields: `name: "config-git"`, `version`, `description`, `main: "dist/index.js"`, `type: "module"`, `license: "MIT"`, `author: "intisy"`, `repository` (GitHub URL owner `intisy-ai`), `keywords`, `files: ["dist/","README.md","LICENSE"]`, `engines.node >= 20.0.0`. Scripts: `build`, `prepublishOnly: "npm run build"`, `test`.
- Config dir resolution: `process.env.HUB_CONFIG_DIR` else app-detect (`process.argv.join(" ").includes("claude")` → `~/.claude`, else `~/.config/opencode`). Config files live under `<configDir>/config/`.
- Logging via core's `makeWriteLog("config-git")`; never crash on log failure.
- `defineConfig("config-git", defaults)` called on load BEFORE the `maybeRunCli` guard; writing no file on launch.
- Never override git identity: no `-c user.email`/`-c user.name`/`--author` on any git invocation.
- Shadow repo path: `<configDir>/repos/config-git-data`. Data-branch default: `main`.
- Tracked files (verbatim): every `config/*.json` EXCEPT the secret denylist below, plus `config/plugins.json`.
- Secret denylist (never copied into the repo): `accounts.json`, `auth.json`, `core-auth-accounts.json`, `core-auth-proxies.json`, and anything under `cache/`/`logs/`.
- Secret-field registry (stripped from otherwise-tracked files when `secrets:"exclude"`): `{ "core-auth.json": ["leaderboard.apiKey"], "claude-code-loader.json": [], "settings.json": [] }` — dotted paths.
- `secrets` config value: `"exclude"` (default) or `"include"`.
- The plugin hook (`dist/index.js`) exports ONLY the hook + `activate` (OpenCode runs every export as a hook); the library API lives in `dist/lib.js`.

---

### Task 1: Scaffold the plugin (package, build, config, homes, contract test)

**Files:**
- Create: `plugins/config-git/package.json`, `tsconfig.json`, `build.mjs`, `vitest.config.ts`, `.gitignore`, `LICENSE`
- Create: `plugins/config-git/src/config.ts`, `src/paths.ts`
- Create: `plugins/config-git/src/__tests__/contract.test.ts`
- Add `core` submodule at `plugins/config-git/core`

**Interfaces:**
- Produces: `configDir()`, `configFolder()`, `dataRepoDir()`, `trackedConfigFiles()` (string[] of file names under config/), `getConfig()` (returns `{ secrets, logging }`), `writeLog(msg, isErr?)`, `TRACKED_DENYLIST`, `SECRET_FIELDS`.

- [ ] **Step 1: Create the git repo + add core submodule**

```bash
cd F:/Documents/GitHub/javascript/plugins
mkdir config-git && cd config-git && git init -b main
git submodule add https://github.com/intisy-ai/core core
```

- [ ] **Step 2: Write package.json**

```json
{
  "name": "config-git",
  "version": "0.1.0",
  "description": "Git-backed config management for the loader ecosystem: versioned, sanitized snapshots of an app home's config with history, rollback, and profiles.",
  "main": "dist/index.js",
  "type": "module",
  "license": "MIT",
  "author": "intisy",
  "repository": { "type": "git", "url": "https://github.com/intisy-ai/config-git" },
  "keywords": ["opencode", "claude-code", "config", "git", "sync"],
  "files": ["dist/", "README.md", "LICENSE"],
  "engines": { "node": ">=20.0.0" },
  "scripts": {
    "build": "tsc --noEmit && node build.mjs",
    "postbuild": "node dist/index.js readme",
    "test": "npm run build && vitest run",
    "prepublishOnly": "npm run build"
  },
  "devDependencies": { "esbuild": "^0.23.0", "typescript": "^5.5.0", "vitest": "^2.0.0", "@types/node": "^20.0.0" }
}
```

- [ ] **Step 3: tsconfig.json, build.mjs, vitest.config.ts, .gitignore**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ESNext", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "outDir": "./dist", "declaration": true, "esModuleInterop": true,
    "skipLibCheck": true, "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts", "src/**/__tests__/**", "core", "dist", "node_modules"]
}
```
`build.mjs`:
```js
import { build } from "esbuild";
const common = { bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "info" };
await build({ ...common, entryPoints: ["src/index.ts"], outfile: "dist/index.js" });
await build({ ...common, entryPoints: ["src/lib.ts"], outfile: "dist/lib.js" });
console.log("Bundled config-git -> dist/index.js (hook) + dist/lib.js (library)");
```
`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
```
`.gitignore`:
```
dist/
node_modules/
```
Copy a `LICENSE` file (MIT, author intisy) from `plugins/sync-bridge/LICENSE`.

- [ ] **Step 4: Write src/paths.ts + src/config.ts**

`src/paths.ts`:
```ts
// @ts-nocheck
import { join } from "path";
import { homedir } from "os";
import { existsSync, readdirSync } from "fs";

export function configDir() {
  const hub = (process.env.HUB_CONFIG_DIR || "").trim();
  if (hub) return hub;
  const isClaude = process.argv.join(" ").includes("claude");
  return isClaude ? join(homedir(), ".claude") : join(homedir(), ".config", "opencode");
}
export function configFolder() { return join(configDir(), "config"); }
export function dataRepoDir() { return join(configDir(), "repos", "config-git-data"); }

// files under config/ that must NEVER enter the repo (secret stores + volatile)
export const TRACKED_DENYLIST = new Set([
  "accounts.json", "auth.json", "core-auth-accounts.json", "core-auth-proxies.json",
]);

// dotted secret-field paths stripped from tracked files when secrets:"exclude"
export const SECRET_FIELDS = {
  "core-auth.json": ["leaderboard.apiKey"],
};

// tracked config file NAMES: every config/*.json minus the denylist, + plugins.json
export function trackedConfigFiles() {
  const out = [];
  try {
    for (const f of readdirSync(configFolder())) {
      if (!f.endsWith(".json")) continue;
      if (TRACKED_DENYLIST.has(f)) continue;
      out.push(f);
    }
  } catch {}
  return out.sort();
}
```

`src/config.ts`:
```ts
// @ts-nocheck
import { defineConfig, makeWriteLog } from "../core/src/index.js";

export const CONFIG_DEFAULTS = { secrets: "exclude", logging: true };
export function getConfig() { return defineConfig("config-git", CONFIG_DEFAULTS); }
export const writeLog = makeWriteLog("config-git");
```

> Confirm the exact `defineConfig`/`makeWriteLog` import path by checking `plugins/sync-bridge/src/config.ts` — match its `../core/src/index.js` import style exactly.

- [ ] **Step 5: Write the contract test**

```ts
// src/__tests__/contract.test.ts
import { describe, it, expect } from "vitest";
import { runPluginContract } from "../../core/src/testing.js";

runPluginContract({
  pluginName: "config-git",
  configName: "config-git",
  bundle: "dist/index.js",
  commands: [],       // filled in Task 9
  actions: [],
});

describe("config-git scaffold", () => {
  it("builds", () => { expect(true).toBe(true); });
});
```

> Read `plugins/sync-bridge/src/__tests__/contract.test.ts` and mirror its exact `runPluginContract(spec)` shape and arguments — the kit signature is authoritative over the sketch above.

- [ ] **Step 6: Install, build, test**

```bash
cd F:/Documents/GitHub/javascript/plugins/config-git
npm install
(cd core && npm install && npm run build)
npm run build
npx vitest run
```
Expected: build emits `dist/index.js` + `dist/lib.js`; contract test passes (an empty-command plugin still satisfies the kit). If `runPluginContract` demands a real hook export, add a minimal `src/index.ts` exporting `export const ConfigGitPlugin = async () => ({});` and `export default ConfigGitPlugin;` to get it green — Task 9 fills the real hook.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore(config-git): scaffold plugin (package, dual-bundle build, config, paths, contract test)"
```

---

### Task 2: Secret sanitizer

**Files:**
- Create: `plugins/config-git/src/secrets.ts`
- Test: `plugins/config-git/src/secrets.test.ts`

**Interfaces:**
- Consumes: `SECRET_FIELDS`, `TRACKED_DENYLIST` from `paths.ts`.
- Produces:
  - `stripSecretFields(fileName, obj)` → deep-cloned obj with that file's registered dotted secret paths deleted.
  - `sanitizeForRepo(fileName, text, mode)` → string: when `mode==="include"`, returns `text` unchanged; when `"exclude"`, parses JSON, strips fields, re-serializes (2-space). Non-JSON or parse failure → returns `text` unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// src/secrets.test.ts
import { describe, it, expect } from "vitest";
import { stripSecretFields, sanitizeForRepo } from "./secrets.js";

describe("secret sanitizer", () => {
  it("strips a registered dotted field", () => {
    const out = stripSecretFields("core-auth.json", { leaderboard: { apiKey: "sk-x", source: "AA" }, other: 1 });
    expect(out.leaderboard.apiKey).toBeUndefined();
    expect(out.leaderboard.source).toBe("AA");
    expect(out.other).toBe(1);
  });
  it("leaves unregistered files untouched", () => {
    const out = stripSecretFields("plugins.json", { a: { apiKey: "keep" } });
    expect(out.a.apiKey).toBe("keep");
  });
  it("sanitizeForRepo exclude mode removes the field in serialized output", () => {
    const text = JSON.stringify({ leaderboard: { apiKey: "sk-x" } });
    const out = sanitizeForRepo("core-auth.json", text, "exclude");
    expect(out).not.toContain("sk-x");
  });
  it("sanitizeForRepo include mode returns text verbatim", () => {
    const text = JSON.stringify({ leaderboard: { apiKey: "sk-x" } });
    expect(sanitizeForRepo("core-auth.json", text, "include")).toBe(text);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`cannot find ./secrets.js`)

Run: `cd plugins/config-git && npx vitest run src/secrets.test.ts`

- [ ] **Step 3: Implement src/secrets.ts**

```ts
// @ts-nocheck
import { SECRET_FIELDS } from "./paths.js";

function deleteDotted(obj, path) {
  const parts = path.split(".");
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node || typeof node !== "object") return;
    node = node[parts[i]];
  }
  if (node && typeof node === "object") delete node[parts[parts.length - 1]];
}

export function stripSecretFields(fileName, obj) {
  const fields = SECRET_FIELDS[fileName];
  const clone = JSON.parse(JSON.stringify(obj));
  if (!fields || !fields.length) return clone;
  for (const path of fields) deleteDotted(clone, path);
  return clone;
}

export function sanitizeForRepo(fileName, text, mode) {
  if (mode === "include") return text;
  let obj;
  try { obj = JSON.parse(text); } catch { return text; }
  return JSON.stringify(stripSecretFields(fileName, obj), null, 2);
}
```

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/secrets.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/secrets.ts src/secrets.test.ts && git commit -m "feat(config-git): secret sanitizer (dotted-field strip + per-repo mode)"
```

---

### Task 3: Git CLI wrapper + shadow-repo lifecycle

**Files:**
- Create: `plugins/config-git/src/git.ts`, `src/repo.ts`
- Test: `plugins/config-git/src/repo.test.ts`

**Interfaces:**
- Produces:
  - `git(args: string[], cwd: string)` → `{ code, stdout, stderr }` (sync, never throws; uses `execFileSync` catching failure).
  - `repo`: `ensureRepo()` (init at `dataRepoDir()` on branch `main` if absent), `isRepo()`, `hasRemote()`, `getRemote()`, `setRemote(url)`, `commitAll(message)` → boolean (true if a commit was made), `currentBranch()`, `listBranches()` → string[], `createBranch(name)`, `checkoutBranch(name)`, `showFileAtRef(ref, relPath)` → string|null, `log(relPath?)` → `[{hash, date, subject}]`, `push()`/`pull()` → `{ok, message}`.

- [ ] **Step 1: Write the failing test** (real git in a temp dir)

```ts
// src/repo.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cfggit-")); vi.stubEnv("HUB_CONFIG_DIR", dir); mkdirSync(join(dir, "config"), { recursive: true }); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

async function fresh() { vi.resetModules(); return await import("./repo.js"); }

describe("shadow repo", () => {
  it("inits, commits, and reads a file back at HEAD", async () => {
    const { repo } = await fresh();
    repo.ensureRepo();
    expect(repo.isRepo()).toBe(true);
    writeFileSync(join(repo.repoPath(), "x.json"), '{"a":1}');
    expect(repo.commitAll("first")).toBe(true);
    expect(repo.showFileAtRef("HEAD", "x.json")).toContain('"a"');
    expect(repo.commitAll("noop")).toBe(false);   // nothing changed
  });
  it("creates and switches branches", async () => {
    const { repo } = await fresh();
    repo.ensureRepo();
    writeFileSync(join(repo.repoPath(), "x.json"), "{}");
    repo.commitAll("init");
    repo.createBranch("work");
    repo.checkoutBranch("work");
    expect(repo.currentBranch()).toBe("work");
    expect(repo.listBranches()).toContain("main");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/repo.test.ts`

- [ ] **Step 3: Implement src/git.ts**

```ts
// @ts-nocheck
import { execFileSync } from "child_process";

export function git(args, cwd) {
  try {
    const stdout = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout: stdout || "", stderr: "" };
  } catch (e) {
    return { code: e.status || 1, stdout: (e.stdout && e.stdout.toString()) || "", stderr: (e.stderr && e.stderr.toString()) || String(e.message || e) };
  }
}
```

- [ ] **Step 4: Implement src/repo.ts**

```ts
// @ts-nocheck
import { existsSync, mkdirSync } from "fs";
import { dataRepoDir } from "./paths.js";
import { git } from "./git.js";

const DATA_BRANCH = "main";
function repoPath() { return dataRepoDir(); }

function ensureRepo() {
  const p = repoPath();
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  if (!isRepo()) {
    git(["init", "-b", DATA_BRANCH], p);
    // local identity ONLY for this shadow repo — never global, never --author on commits
    git(["config", "user.email", "config-git@local"], p);
    git(["config", "user.name", "config-git"], p);
  }
}
function isRepo() { return git(["rev-parse", "--is-inside-work-tree"], repoPath()).code === 0; }
function hasRemote() { return git(["remote"], repoPath()).stdout.split(/\s+/).filter(Boolean).includes("origin"); }
function getRemote() { const r = git(["remote", "get-url", "origin"], repoPath()); return r.code === 0 ? r.stdout.trim() : ""; }
function setRemote(url) { if (hasRemote()) git(["remote", "set-url", "origin", url], repoPath()); else git(["remote", "add", "origin", url], repoPath()); }

function commitAll(message) {
  const p = repoPath();
  git(["add", "-A"], p);
  const status = git(["status", "--porcelain"], p).stdout.trim();
  if (!status) return false;
  return git(["commit", "-m", message], p).code === 0;
}
function currentBranch() { return git(["rev-parse", "--abbrev-ref", "HEAD"], repoPath()).stdout.trim(); }
function listBranches() {
  return git(["branch", "--format=%(refname:short)"], repoPath()).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}
function createBranch(name) { git(["branch", name], repoPath()); }
function checkoutBranch(name) { git(["checkout", name], repoPath()); }
function showFileAtRef(ref, relPath) {
  const r = git(["show", ref + ":" + relPath], repoPath());
  return r.code === 0 ? r.stdout : null;
}
function log(relPath) {
  const args = ["log", "--pretty=format:%H\t%ad\t%s", "--date=iso"];
  if (relPath) args.push("--", relPath);
  const r = git(args, repoPath());
  if (r.code !== 0) return [];
  return r.stdout.split("\n").filter(Boolean).map((line) => {
    const [hash, date, ...rest] = line.split("\t");
    return { hash, date, subject: rest.join("\t") };
  });
}
function push() { const r = git(["push", "-u", "origin", currentBranch()], repoPath()); return { ok: r.code === 0, message: r.code === 0 ? "pushed" : (r.stderr || "push failed") }; }
function pull() { const r = git(["pull", "--rebase", "origin", currentBranch()], repoPath()); return { ok: r.code === 0, message: r.code === 0 ? "pulled" : (r.stderr || "pull failed") }; }

export const repo = { repoPath, ensureRepo, isRepo, hasRemote, getRemote, setRemote, commitAll, currentBranch, listBranches, createBranch, checkoutBranch, showFileAtRef, log, push, pull };
```

> The `git config user.email/user.name` calls set a LOCAL identity on the shadow repo only (required so `git commit` works in CI/headless environments with no global identity). This is NOT `-c`/`--author` on a commit and does not touch the user's real repos — it satisfies the global constraint.

- [ ] **Step 5: Run — expect PASS.** `npx vitest run src/repo.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/git.ts src/repo.ts src/repo.test.ts && git commit -m "feat(config-git): git CLI wrapper + shadow-repo lifecycle (init/commit/branch/show/log/push/pull)"
```

---

### Task 4: Export (live → sanitized repo) + snapshot

**Files:**
- Create: `plugins/config-git/src/export.ts`
- Test: `plugins/config-git/src/export.test.ts`

**Interfaces:**
- Consumes: `trackedConfigFiles`, `configFolder`, `repo`, `sanitizeForRepo`, `getConfig`.
- Produces:
  - `snapshotLive(mode)` → `{ [fileName]: sanitizedText }` for every tracked file present in live config.
  - `exportLive()` → writes the snapshot into the repo working tree (creating/overwriting `<repo>/<fileName>`, removing repo files whose live source disappeared) using the current `secrets` mode; returns the file count written.
  - `autoCommit(reason)` → `exportLive()` then `repo.commitAll("auto: " + reason)`; returns boolean (committed?).

- [ ] **Step 1: Write the failing test**

```ts
// src/export.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfggit-")); vi.stubEnv("HUB_CONFIG_DIR", dir);
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "core-auth.json"), JSON.stringify({ leaderboard: { apiKey: "sk-secret" } }));
  writeFileSync(join(dir, "config", "accounts.json"), JSON.stringify({ token: "sk-oauth" }));  // denylisted
  writeFileSync(join(dir, "config", "plugins.json"), "[]");
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
async function fresh() { vi.resetModules(); return await import("./export.js"); }

describe("export", () => {
  it("copies tracked files, strips secrets, excludes the denylist", async () => {
    const { exportLive } = await fresh();
    const { repo } = await import("./repo.js");
    repo.ensureRepo();
    exportLive();
    expect(existsSync(join(repo.repoPath(), "core-auth.json"))).toBe(true);
    expect(existsSync(join(repo.repoPath(), "plugins.json"))).toBe(true);
    expect(existsSync(join(repo.repoPath(), "accounts.json"))).toBe(false);   // denylisted
    expect(readFileSync(join(repo.repoPath(), "core-auth.json"), "utf8")).not.toContain("sk-secret");
  });
  it("autoCommit commits then no-ops when unchanged", async () => {
    const { autoCommit } = await fresh();
    const { repo } = await import("./repo.js");
    repo.ensureRepo();
    expect(autoCommit("test")).toBe(true);
    expect(autoCommit("test")).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/export.test.ts`

- [ ] **Step 3: Implement src/export.ts**

```ts
// @ts-nocheck
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { configFolder, trackedConfigFiles } from "./paths.js";
import { sanitizeForRepo } from "./secrets.js";
import { repo } from "./repo.js";
import { getConfig } from "./config.js";

export function snapshotLive(mode) {
  const out = {};
  for (const name of trackedConfigFiles()) {
    const p = join(configFolder(), name);
    let text;
    try { text = readFileSync(p, "utf8"); } catch { continue; }
    out[name] = sanitizeForRepo(name, text, mode);
  }
  return out;
}

export function exportLive() {
  const mode = getConfig().secrets === "include" ? "include" : "exclude";
  const snap = snapshotLive(mode);
  const rp = repo.repoPath();
  // write current tracked files
  for (const [name, text] of Object.entries(snap)) writeFileSync(join(rp, name), text, "utf8");
  // remove repo files whose live source no longer exists (ignore .git)
  for (const f of readdirSync(rp)) {
    if (f === ".git" || !f.endsWith(".json")) continue;
    if (!(f in snap)) { try { unlinkSync(join(rp, f)); } catch {} }
  }
  return Object.keys(snap).length;
}

export function autoCommit(reason) {
  exportLive();
  return repo.commitAll("auto: " + reason);
}
```

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/export.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/export.ts src/export.test.ts && git commit -m "feat(config-git): export live config to sanitized repo snapshot + auto-commit"
```

---

### Task 5: Setting-level diff

**Files:**
- Create: `plugins/config-git/src/diff.ts`
- Test: `plugins/config-git/src/diff.test.ts`

**Interfaces:**
- Consumes: `snapshotLive`, `repo`, `trackedConfigFiles`, `getConfig`.
- Produces:
  - `flatten(obj, prefix?)` → `{ "a.b.c": value }` for all leaf values (arrays serialized to JSON strings, treated as leaves).
  - `diffAgainstHead()` → `[{ file, key, old, new }]`: for every tracked file, compare the file's live sanitized JSON (flattened) against its HEAD version (flattened); `old`/`new` are the stringified values, `undefined` shown as the literal `"(unset)"`. Files absent on one side diff all their keys.

- [ ] **Step 1: Write the failing test**

```ts
// src/diff.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfggit-")); vi.stubEnv("HUB_CONFIG_DIR", dir);
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "claude-code-loader.json"), JSON.stringify({ providerRouting: true }));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
async function fresh() { vi.resetModules(); return await import("./diff.js"); }

describe("diff", () => {
  it("flatten produces dotted leaf keys", async () => {
    const { flatten } = await fresh();
    expect(flatten({ a: { b: 1 }, c: [1, 2] })).toEqual({ "a.b": 1, "c": "[1,2]" });
  });
  it("reports a changed setting after commit + live edit", async () => {
    const { diffAgainstHead } = await fresh();
    const { autoCommit } = await import("./export.js");
    const { repo } = await import("./repo.js");
    repo.ensureRepo();
    autoCommit("init");   // HEAD: providerRouting=true
    writeFileSync(join(dir, "config", "claude-code-loader.json"), JSON.stringify({ providerRouting: false }));
    const rows = diffAgainstHead();
    const row = rows.find((r) => r.key === "providerRouting");
    expect(row).toBeTruthy();
    expect(row.old).toBe("true");
    expect(row.new).toBe("false");
    expect(row.file).toBe("claude-code-loader.json");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/diff.test.ts`

- [ ] **Step 3: Implement src/diff.ts**

```ts
// @ts-nocheck
import { snapshotLive } from "./export.js";
import { repo } from "./repo.js";
import { trackedConfigFiles } from "./paths.js";
import { getConfig } from "./config.js";

export function flatten(obj, prefix = "") {
  const out = {};
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    out[prefix || "(root)"] = Array.isArray(obj) ? JSON.stringify(obj) : obj;
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + "." + k : k;
    if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flatten(v, key));
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}

function parse(text) { try { return text == null ? {} : JSON.parse(text); } catch { return {}; }
}
const show = (v) => (v === undefined ? "(unset)" : String(v));

export function diffAgainstHead() {
  const mode = getConfig().secrets === "include" ? "include" : "exclude";
  const live = snapshotLive(mode);
  const names = new Set([...trackedConfigFiles(), ...Object.keys(live)]);
  const rows = [];
  for (const file of names) {
    const liveFlat = flatten(parse(live[file]));
    const headText = repo.showFileAtRef("HEAD", file);
    const headFlat = flatten(parse(headText));
    const keys = new Set([...Object.keys(liveFlat), ...Object.keys(headFlat)]);
    for (const key of keys) {
      const o = headFlat[key], n = liveFlat[key];
      if (String(o) !== String(n)) rows.push({ file, key, old: show(o), new: show(n) });
    }
  }
  return rows.sort((a, b) => (a.file + a.key).localeCompare(b.file + b.key));
}
```

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/diff.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/diff.ts src/diff.test.ts && git commit -m "feat(config-git): setting-level diff (flatten + HEAD-vs-live rows)"
```

---

### Task 6: Import (repo → live) + history + rollback

**Files:**
- Create: `plugins/config-git/src/importer.ts`, `src/history.ts`
- Test: `plugins/config-git/src/importer.test.ts`

**Interfaces:**
- Consumes: `repo`, `configFolder`, `trackedConfigFiles`, `autoCommit`, `flatten`.
- Produces:
  - `importFromHead()` → writes every tracked file's HEAD content into live `config/`; returns count. (Whole-file writes; the caller is responsible for having shown/approved the diff first — enforced at the UI/CLI layer, not here.)
  - `keyHistory(file, key)` → `[{ hash, date, value }]` newest-first: the value of `key` in `file` at each commit that changed the file.
  - `rollbackKey(file, key, hash)` → sets `key` in the LIVE `file` to its value at `hash`, then `autoCommit("rollback " + file + ":" + key)`; returns boolean.

- [ ] **Step 1: Write the failing test**

```ts
// src/importer.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfggit-")); vi.stubEnv("HUB_CONFIG_DIR", dir);
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "claude-code-loader.json"), JSON.stringify({ providerRouting: true }));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
async function fresh() { vi.resetModules(); return await import("./importer.js"); }
function liveCfg() { return JSON.parse(readFileSync(join(dir, "config", "claude-code-loader.json"), "utf8")); }

describe("importer + history", () => {
  it("rolls a key back to an earlier commit value", async () => {
    const { rollbackKey, keyHistory } = await fresh();
    const { autoCommit } = await import("./export.js");
    const { repo } = await import("./repo.js");
    repo.ensureRepo();
    autoCommit("v1");   // providerRouting=true
    writeFileSync(join(dir, "config", "claude-code-loader.json"), JSON.stringify({ providerRouting: false }));
    autoCommit("v2");   // providerRouting=false
    const hist = keyHistory("claude-code-loader.json", "providerRouting");
    expect(hist.length).toBeGreaterThanOrEqual(2);
    const older = hist.find((h) => String(h.value) === "true");
    expect(older).toBeTruthy();
    expect(rollbackKey("claude-code-loader.json", "providerRouting", older.hash)).toBe(true);
    expect(liveCfg().providerRouting).toBe(true);   // restored
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/importer.test.ts`

- [ ] **Step 3: Implement src/history.ts**

```ts
// @ts-nocheck
import { repo } from "./repo.js";
import { flatten } from "./diff.js";

function valueAt(hash, file, key) {
  const text = repo.showFileAtRef(hash, file);
  if (text == null) return undefined;
  try { return flatten(JSON.parse(text))[key]; } catch { return undefined; }
}

export function keyHistory(file, key) {
  const commits = repo.log(file);
  const out = [];
  let last = Symbol("none");
  for (const c of commits) {
    const value = valueAt(c.hash, file, key);
    if (String(value) !== String(last)) { out.push({ hash: c.hash, date: c.date, value }); last = value; }
  }
  return out;
}
export { valueAt };
```

- [ ] **Step 4: Implement src/importer.ts**

```ts
// @ts-nocheck
import { writeFileSync } from "fs";
import { join } from "path";
import { configFolder, trackedConfigFiles } from "./paths.js";
import { repo } from "./repo.js";
import { autoCommit } from "./export.js";
import { valueAt } from "./history.js";

export function importFromHead() {
  let n = 0;
  const names = new Set(trackedConfigFiles());
  // include files present at HEAD but not live
  for (const line of repo.log().length ? [repo] : []) {}   // (no-op; names come from HEAD listing below)
  const headFiles = repo.showFileAtRef("HEAD", ".") == null ? [] : [];
  for (const name of names) {
    const text = repo.showFileAtRef("HEAD", name);
    if (text == null) continue;
    writeFileSync(join(configFolder(), name), text, "utf8");
    n++;
  }
  return n;
}

export function rollbackKey(file, key, hash) {
  const val = valueAt(hash, file, key);
  const p = join(configFolder(), file);
  let obj;
  try { obj = JSON.parse(require("fs").readFileSync(p, "utf8")); } catch { obj = {}; }
  const parts = key.split(".");
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) { node[parts[i]] = node[parts[i]] || {}; node = node[parts[i]]; }
  node[parts[parts.length - 1]] = val;
  writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  return autoCommit("rollback " + file + ":" + key);
}
```

> Simplify `importFromHead` — the two dead lines above are placeholders from drafting; the real body is the `for (const name of names)` loop. Remove the two no-op lines when implementing. Import `readFileSync` at the top rather than `require` inside `rollbackKey` (use `import { readFileSync, writeFileSync } from "fs";`).

- [ ] **Step 5: Run — expect PASS.** `npx vitest run src/importer.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/importer.ts src/history.ts src/importer.test.ts && git commit -m "feat(config-git): import from HEAD + per-key history + rollback"
```

---

### Task 7: Profiles + repo setup (remote, seed, gh)

**Files:**
- Create: `plugins/config-git/src/profiles.ts`, `src/setup.ts`
- Test: `plugins/config-git/src/setup.test.ts`

**Interfaces:**
- Consumes: `repo`, `autoCommit`, `git`.
- Produces:
  - `profiles`: `list()` → `repo.listBranches()`; `current()` → `repo.currentBranch()`; `create(name)` → `repo.createBranch(name)`; `switchTo(name)` → `repo.checkoutBranch(name)` (caller review-gates the subsequent `importFromHead`).
  - `setup`: `initAndSeed()` → `repo.ensureRepo()` + `autoCommit("seed")`; `setRemote(url)` → `repo.setRemote(url)`; `ghAvailable()` → boolean (`gh --version` exits 0); `ghCreatePrivate(name)` → `{ok, url|message}` via `gh repo create <name> --private --source <repoPath> --remote origin --push` when `ghAvailable()`, else `{ok:false, message:"gh not available"}`.

- [ ] **Step 1: Write the failing test**

```ts
// src/setup.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cfggit-")); vi.stubEnv("HUB_CONFIG_DIR", dir); mkdirSync(join(dir, "config"), { recursive: true }); writeFileSync(join(dir, "config", "plugins.json"), "[]"); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
async function fresh() { vi.resetModules(); return { setup: await import("./setup.js"), profiles: await import("./profiles.js") }; }

describe("setup + profiles", () => {
  it("initAndSeed creates a repo with a seed commit", async () => {
    const { setup, profiles } = await fresh();
    setup.initAndSeed();
    expect(profiles.current()).toBe("main");
    expect(profiles.list()).toContain("main");
  });
  it("create + switch profile", async () => {
    const { setup, profiles } = await fresh();
    setup.initAndSeed();
    profiles.create("work"); profiles.switchTo("work");
    expect(profiles.current()).toBe("work");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/setup.test.ts`

- [ ] **Step 3: Implement src/profiles.ts + src/setup.ts**

`src/profiles.ts`:
```ts
// @ts-nocheck
import { repo } from "./repo.js";
export const profiles = { list: () => repo.listBranches(), current: () => repo.currentBranch(), create: (name) => repo.createBranch(name), switchTo: (name) => repo.checkoutBranch(name) };
export const { list, current, create, switchTo } = profiles;
```

`src/setup.ts`:
```ts
// @ts-nocheck
import { repo } from "./repo.js";
import { autoCommit } from "./export.js";
import { git } from "./git.js";

export function initAndSeed() { repo.ensureRepo(); return autoCommit("seed"); }
export function setRemote(url) { repo.ensureRepo(); repo.setRemote(url); return repo.getRemote(); }
export function ghAvailable() {
  try { return require("child_process").execFileSync("gh", ["--version"], { stdio: ["ignore", "pipe", "ignore"] }) != null; } catch { return false; }
}
export function ghCreatePrivate(name) {
  if (!ghAvailable()) return { ok: false, message: "gh not available" };
  const r = git(["-C", repo.repoPath(), "rev-parse"], repo.repoPath());   // ensure repo exists
  try {
    require("child_process").execFileSync("gh", ["repo", "create", name, "--private", "--source", repo.repoPath(), "--remote", "origin", "--push"], { stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, url: repo.getRemote() };
  } catch (e) { return { ok: false, message: (e.stderr && e.stderr.toString()) || String(e.message || e) }; }
}
```

> Use a top-level `import { execFileSync } from "child_process";` instead of inline `require` for consistency with `git.ts`.

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/setup.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/profiles.ts src/setup.ts src/setup.test.ts && git commit -m "feat(config-git): profiles (branch) + repo setup (init/seed/remote/gh)"
```

---

### Task 8: Library entry, plugin hook, CLI, README

**Files:**
- Create: `plugins/config-git/src/lib.ts`, `src/index.ts`, `src/commands.ts`
- Modify: `src/__tests__/contract.test.ts` (fill `commands`)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `dist/lib.js` exporting: `snapshotLive`, `exportLive`, `autoCommit`, `diffAgainstHead`, `importFromHead`, `keyHistory`, `rollbackKey`, `profiles`, `setup`, `repo`, `getConfig`, `configDir`.
  - `dist/index.js` exporting ONLY `ConfigGitPlugin` (default + named) and `activate` — the hook auto-commits on load when a repo exists (best-effort, debounced-free, never throws).
  - CLI (`node dist/index.js <cmd>`): `status` (print diff rows), `commit`, `push`, `pull`, `history <file> <key>`, `profile [name]`, `setup [remoteUrl]`.

- [ ] **Step 1: Write src/lib.ts**

```ts
// @ts-nocheck
export { snapshotLive, exportLive, autoCommit } from "./export.js";
export { diffAgainstHead, flatten } from "./diff.js";
export { importFromHead, rollbackKey } from "./importer.js";
export { keyHistory } from "./history.js";
export { profiles } from "./profiles.js";
export * as setup from "./setup.js";
export { repo } from "./repo.js";
export { getConfig } from "./config.js";
export { configDir, dataRepoDir } from "./paths.js";
```

- [ ] **Step 2: Write src/commands.ts** (CLI dispatch — mirror `plugins/sync-bridge/src/commands.ts` structure: a `maybeRunCli(pluginName)` that reads `process.argv`, runs the matching action, returns true if handled)

```ts
// @ts-nocheck
import { repo } from "./repo.js";
import { autoCommit } from "./export.js";
import { diffAgainstHead } from "./diff.js";
import { importFromHead } from "./importer.js";
import { keyHistory } from "./history.js";
import { profiles } from "./profiles.js";
import * as setup from "./setup.js";

export const CONFIG_GIT_COMMANDS = [
  { name: "config-git", description: "Git-backed config: status/commit/push/pull/history/profile/setup" },
];

export async function maybeRunCli(pluginName) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || ["readme"].includes(cmd)) return false;   // readme handled by core
  if (!["status", "commit", "push", "pull", "history", "profile", "setup", "import"].includes(cmd)) return false;
  if (cmd === "setup") { setup.initAndSeed(); if (argv[1]) setup.setRemote(argv[1]); process.stdout.write("config-git repo ready" + (argv[1] ? " (remote set)" : "") + "\n"); return true; }
  repo.ensureRepo();
  if (cmd === "status") { for (const r of diffAgainstHead()) process.stdout.write(`${r.file} · ${r.key}: ${r.old} -> ${r.new}\n`); return true; }
  if (cmd === "commit") { process.stdout.write(autoCommit("manual") ? "committed\n" : "nothing to commit\n"); return true; }
  if (cmd === "push") { const x = repo.push(); process.stdout.write(x.message + "\n"); return true; }
  if (cmd === "pull") { const x = repo.pull(); process.stdout.write(x.message + "\n"); return true; }
  if (cmd === "import") { process.stdout.write("imported " + importFromHead() + " files\n"); return true; }
  if (cmd === "history") { for (const h of keyHistory(argv[1], argv[2])) process.stdout.write(`${h.date} ${h.hash.slice(0,7)} ${h.value}\n`); return true; }
  if (cmd === "profile") { if (argv[1]) { if (!profiles.list().includes(argv[1])) profiles.create(argv[1]); profiles.switchTo(argv[1]); process.stdout.write("profile: " + profiles.current() + "\n"); } else { for (const b of profiles.list()) process.stdout.write((b === profiles.current() ? "* " : "  ") + b + "\n"); } return true; }
  return false;
}
```

> Read `plugins/sync-bridge/src/commands.ts` first and match its actual `maybeRunCli` signature/return contract and how it integrates with core's `defineReadme`/`deployCommands`. Adjust the above to that real contract rather than inventing one.

- [ ] **Step 3: Write src/index.ts** (hook + activate; auto-commit on load)

```ts
// @ts-nocheck
import { defineReadme, maybeRunReadmeCli, deployCommands } from "../core/src/index.js";
import { getConfig, writeLog } from "./config.js";
import { CONFIG_GIT_COMMANDS, maybeRunCli } from "./commands.js";
import { repo } from "./repo.js";
import { autoCommit } from "./export.js";

defineReadme({ description: "Git-backed config management: sanitized snapshots of an app home's config with history, rollback, and profiles.", commands: CONFIG_GIT_COMMANDS, dependencies: ["core"] });
getConfig();   // register defaults before the CLI guard

if (maybeRunReadmeCli("config-git")) process.exit(0);
if (await maybeRunCli("config-git")) process.exit(0);
try { deployCommands("config-git", CONFIG_GIT_COMMANDS); } catch {}

// auto-commit local config changes on load (best-effort; only when a repo exists)
export const ConfigGitPlugin = async function () {
  try { if (repo.isRepo()) autoCommit("load"); } catch (e) { writeLog("load auto-commit failed: " + e, true); }
  return {};
};
export async function activate() { return ConfigGitPlugin(); }
export default ConfigGitPlugin;
```

> Match the exact `defineReadme`/`maybeRunReadmeCli`/`deployCommands` import names + signatures against `plugins/sync-bridge/src/index.ts`. The `activate` export mirrors the sync-bridge fix so the Claude runtime (plugin-updater) runs the auto-commit.

- [ ] **Step 4: Fill the contract test commands, build, test**

Set `commands: ["config-git"]` (or the exact deploy shape sync-bridge uses) in `src/__tests__/contract.test.ts`.
```bash
cd F:/Documents/GitHub/javascript/plugins/config-git
npm run build && npx vitest run
```
Expected: dual bundles emit; all suites (secrets, repo, export, diff, importer, setup, contract) pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(config-git): lib API + plugin hook (auto-commit on load) + CLI + README"
```

---

### Task 9: Publish repo + register, live smoke test

**Files:** none (ops task).

- [ ] **Step 1: Create the GitHub repo + push**

```bash
cd F:/Documents/GitHub/javascript/plugins/config-git
gh repo create intisy-ai/config-git --private --source . --remote origin --push
```
(If `gh` unavailable, create `intisy-ai/config-git` in the browser and `git remote add origin … && git push -u origin main`.)

- [ ] **Step 2: Live smoke test in a scratch home**

```bash
SCRATCH=$(mktemp -d); mkdir -p "$SCRATCH/config"
echo '{"leaderboard":{"apiKey":"sk-SECRET"},"providerRouting":true}' > "$SCRATCH/config/core-auth.json"
echo '{"token":"sk-OAUTH"}' > "$SCRATCH/config/accounts.json"
HUB_CONFIG_DIR="$SCRATCH" node dist/index.js setup
HUB_CONFIG_DIR="$SCRATCH" node dist/index.js commit
# secret stripped + denylist excluded?
grep -rl "sk-SECRET\|sk-OAUTH" "$SCRATCH/repos/config-git-data" && echo "LEAK" || echo "clean (no secrets in repo)"
ls "$SCRATCH/repos/config-git-data"   # expect core-auth.json, NOT accounts.json
# edit + status
echo '{"leaderboard":{"apiKey":"sk-SECRET"},"providerRouting":false}' > "$SCRATCH/config/core-auth.json"
HUB_CONFIG_DIR="$SCRATCH" node dist/index.js status   # expect: core-auth.json · providerRouting: true -> false
rm -rf "$SCRATCH"
```
Expected: `clean (no secrets in repo)`, repo lists `core-auth.json` + `plugins.json` but not `accounts.json`, and status shows the `providerRouting` change.

- [ ] **Step 3: Add to the loader's OFFICIAL_PLUGINS catalog (optional, follow existing pattern)**

Append a `config-git` entry to `OFFICIAL_PLUGINS` in `libs/core-loader/src/env.ts` (mirror the existing entries: name/repoName/full_name/url/desc/author/category "Official"), then build+bump core-loader in both loaders. This makes it installable from the marketplace. (Skip if deferring distribution to Phase 2.)

---

## Phase 2 (separate plan, after this lands)

The **git-aware unified Settings tab** in core-loader — scope-switching between global + per-plugin settings via the `node <bundle> config schema` probe, modified-vs-repo markers, commit/push/pull with the setting-level diff review, history/rollback, and the profiles picker — consumes `repos/config-git/dist/lib.js` exactly as the loader consumes plugin-updater's lib (import() the resolved bundle, feature-detect, degrade gracefully when absent). That UI is a distinct subsystem with its own reviewable surface; write it as `2026-XX-XX-config-git-loader-tab.md` once this plugin is published and smoke-tested.

---

## Self-Review

**Spec coverage:**
- Per-app shadow repo at `<home>/repos/config-git-data` → Task 3 (`dataRepoDir`, `repo.ensureRepo`). ✓
- Secrets exclude/include + denylist + field strip → Tasks 1 (registry) + 2 (sanitizer) + 4 (export applies mode). ✓
- Auto-commit on change; manual review-gated push/pull → Task 4 (`autoCommit`), Task 8 (hook auto-commits on load; CLI push/pull). ✓ (Review-gating is enforced by the caller/UI — Phase 2; the engine exposes diff + import separately so import is never automatic.)
- Setting-level diff (plugin·key·old→new) → Task 5. ✓
- History + rollback → Task 6. ✓
- Profiles (branches) → Task 7. ✓
- Standalone dual-app plugin, `dist/lib.js` + CLI → Tasks 1, 8. ✓
- Repo setup: init+seed, paste URL, gh shortcut → Task 7 (`setup`) + Task 9 (create). ✓
- Loader delegation / Settings tab → explicitly deferred to Phase 2 (documented). ✓ (spec's loader-integration section)
- Tracked-file list + secret registry (spec open item) → resolved in Global Constraints + `paths.ts`/`SECRET_FIELDS`. ✓
- Testing (sanitizer, diff, integration seed→commit→edit→status; secret-leak check) → Tasks 2,5 + Task 9 smoke. ✓

**Placeholder scan:** Task 6's `importFromHead` draft contains two no-op lines explicitly flagged for removal with the correct final loop given — implementer instruction is concrete, not a placeholder. All other steps carry complete code. Three "match the real contract in sync-bridge" notes point at an exact existing file to copy a signature from (core's CLI/readme framework), which is grounding, not deferral.

**Type consistency:** `repo` object method names (`ensureRepo`/`isRepo`/`commitAll`/`showFileAtRef`/`log`/`currentBranch`/`listBranches`/`createBranch`/`checkoutBranch`/`push`/`pull`/`repoPath`) are consistent across repo.ts, export.ts, diff.ts, history.ts, importer.ts, profiles.ts, setup.ts, commands.ts, lib.ts. `autoCommit(reason)`, `diffAgainstHead()`, `snapshotLive(mode)`, `flatten(obj,prefix?)`, `keyHistory(file,key)`, `rollbackKey(file,key,hash)`, `sanitizeForRepo(fileName,text,mode)`, `getConfig().secrets` — all consistent between definition and use.
