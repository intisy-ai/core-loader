# Proxy Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the ecosystem three proxy scopes (global / per-provider / per-account) with a resolution hierarchy, per-scope mode, and an IP-rate-limit quality signal that only penalizes a proxy when the account still has quota.

**Architecture:** Extend the existing single-pool `ProxyManager` in `libs/core-auth` — each proxy carries a `scope` tag; selection walks account→provider→global→direct; a v1→v2 store migration preserves current behavior. Providers report `ipSuspected` on rate-limits. A unified scope-tabbed Proxies view is added to `libs/core-loader` and consumed by both loaders.

**Tech Stack:** TypeScript (ESNext, NodeNext), esbuild-bundled submodules, vitest.

## Global Constraints

- All source is TypeScript in `src/`; never commit `dist/`. Build with `npm run build`.
- core-auth files are `// @ts-nocheck` — keep that header on modified/new core-auth files.
- Never break the git identity rule (no `-c user.email`/`--author`); commit as the repo's configured identity.
- Propagation: edit `libs/<x>/src` → `npm run build` → commit+push → in each consumer `git -C <submodule> fetch && git -C <submodule> reset --hard <sha>` → `npm run build` → commit pointer bump → push.
- Deployed clones live in `~/.claude/repos/<plugin>` and `~/.config/opencode/repos/<plugin>`; refresh with submodule update + `npm install` + `npm rebuild esbuild` + `npm run build`, then grep the deployed `dist/*.js` to confirm.
- Store file: `<configDir>/config/core-auth-proxies.json`. `MAX_ACCOUNTS_PER_PROXY = 3`. `IP_LIMIT_COOLDOWN_MS = 5 * 60 * 1000`.
- Scope keys are exactly: `"global"`, `"provider:<id>"`, `"account:<id>"`.

---

### Task 1: Add vitest to core-auth + store v2 migration

**Files:**
- Create: `libs/core-auth/vitest.config.ts`
- Modify: `libs/core-auth/package.json` (add vitest devDep + test script)
- Modify: `libs/core-auth/src/proxy/store.ts`
- Test: `libs/core-auth/src/proxy/store.test.ts`

**Interfaces:**
- Produces: `loadProxyStore()` returns a v2 store `{version:2, modes:{default,...}, proxies:[{url,provider,scope,addedAt,stats}], assignments:{}, manualSelection:{}, providers:{}}`; `migrateStore(raw)` (exported) upgrades a v1 object in place and returns it.
- Consumes: nothing.

- [ ] **Step 1: Add vitest to package.json**

Set `scripts.test` to `"vitest run"` and add `"vitest": "^2.0.0"` to `devDependencies`. Then:

```bash
cd libs/core-auth && npm install
```

- [ ] **Step 2: Create vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
```

- [ ] **Step 3: Write the failing migration test**

```ts
// src/proxy/store.test.ts
import { describe, it, expect } from "vitest";
import { migrateStore } from "./store.js";

describe("migrateStore v1 -> v2", () => {
  it("maps owner to account scope and untagged to global", () => {
    const v1 = {
      version: 1, mode: "automatic", providers: {},
      proxies: [
        { url: "http://a", provider: "manual", owner: "acc1", addedAt: 1, stats: {} },
        { url: "http://b", provider: "proxyscrape", addedAt: 2, stats: {} },
      ],
      assignments: { acc1: "http://a" },
      manualSelection: { acc1: ["http://a"] },
    };
    const v2 = migrateStore(v1);
    expect(v2.version).toBe(2);
    expect(v2.modes.default).toBe("automatic");
    expect(v2.proxies[0].scope).toEqual({ type: "account", id: "acc1" });
    expect(v2.proxies[1].scope).toEqual({ type: "global" });
    expect(v2.manualSelection["account:acc1"]).toEqual(["http://a"]);
    expect(v2.manualSelection.acc1).toBeUndefined();
  });

  it("is idempotent on an already-v2 store", () => {
    const v2 = { version: 2, modes: { default: "disabled" }, providers: {}, proxies: [], assignments: {}, manualSelection: {} };
    expect(migrateStore(structuredClone(v2))).toEqual(v2);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd libs/core-auth && npx vitest run src/proxy/store.test.ts`
Expected: FAIL — `migrateStore is not a function`.

- [ ] **Step 5: Implement store v2 + migration**

Replace `libs/core-auth/src/proxy/store.ts` body's `empty()`, `loadProxyStore`, and add `migrateStore`:

```ts
// @ts-nocheck
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { configFolder } from "../env.js";

const FILE = "core-auth-proxies.json";
function storeFile() { return join(configFolder(), FILE); }

function empty() {
  return { version: 2, modes: { default: "disabled" }, providers: {}, proxies: [], assignments: {}, manualSelection: {} };
}

// v1 -> v2: owner -> scope{account}, untagged -> scope{global}; single `mode` ->
// modes.default; manualSelection keyed by accountId -> "account:<id>". Idempotent.
export function migrateStore(raw) {
  if (!raw || typeof raw !== "object") return empty();
  if (raw.version === 2) return { ...empty(), ...raw, modes: { ...empty().modes, ...(raw.modes || {}) } };
  const out = empty();
  out.providers = raw.providers || {};
  out.assignments = raw.assignments || {};
  out.modes = { default: raw.mode || "disabled" };
  out.proxies = (raw.proxies || []).map((p) => ({
    url: p.url, provider: p.provider, addedAt: p.addedAt, stats: p.stats || {},
    scope: p.owner ? { type: "account", id: p.owner } : { type: "global" },
  }));
  out.manualSelection = {};
  for (const [accId, urls] of Object.entries(raw.manualSelection || {})) out.manualSelection["account:" + accId] = urls;
  return out;
}

export function loadProxyStore() {
  try { const f = storeFile(); if (existsSync(f)) return migrateStore(JSON.parse(readFileSync(f, "utf8")) || {}); } catch {}
  return empty();
}

export function saveProxyStore(store) {
  try {
    if (!existsSync(configFolder())) mkdirSync(configFolder(), { recursive: true });
    const file = storeFile();
    const tmp = file + "." + randomBytes(6).toString("hex") + ".tmp";
    writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
  } catch {}
}

export function updateProxyStore(mutator) {
  const store = loadProxyStore();
  mutator(store);
  saveProxyStore(store);
  return store;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd libs/core-auth && npx vitest run src/proxy/store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
cd libs/core-auth
git add package.json package-lock.json vitest.config.ts src/proxy/store.ts src/proxy/store.test.ts
git commit -m "feat(proxy): v2 store with scope tags + v1->v2 migration; add vitest"
```

---

### Task 2: Extract scoring + add quality label

**Files:**
- Create: `libs/core-auth/src/proxy/scoring.ts`
- Test: `libs/core-auth/src/proxy/scoring.test.ts`

**Interfaces:**
- Consumes: store shape from Task 1.
- Produces: `scoreOf(store, proxy)` (number, lower=better), `countAssignments(store, url)` (number), `qualityLabel(proxy)` → `"good"|"fair"|"poor"`, `isIpLimited(proxy, now?)` → boolean (true when `now - stats.lastRateLimitAt < IP_LIMIT_COOLDOWN_MS`), `IP_LIMIT_COOLDOWN_MS`, `MAX_ACCOUNTS_PER_PROXY`.

- [ ] **Step 1: Write the failing test**

```ts
// src/proxy/scoring.test.ts
import { describe, it, expect } from "vitest";
import { scoreOf, qualityLabel, isIpLimited, IP_LIMIT_COOLDOWN_MS } from "./scoring.js";

const store = { assignments: {} };

describe("scoring", () => {
  it("penalizes IP-rate-limit hits (lower is better)", () => {
    const clean = { url: "a", provider: "manual", stats: { checks: 10, failures: 0, avgLatencyMs: 200, ipRateLimitHits: 0 } };
    const limited = { url: "b", provider: "manual", stats: { checks: 10, failures: 0, avgLatencyMs: 200, ipRateLimitHits: 3 } };
    expect(scoreOf(store, clean)).toBeLessThan(scoreOf(store, limited));
  });

  it("qualityLabel reflects IP-limit history", () => {
    expect(qualityLabel({ stats: { checks: 20, failures: 0, avgLatencyMs: 150, ipRateLimitHits: 0 } })).toBe("good");
    expect(qualityLabel({ stats: { checks: 20, failures: 10, avgLatencyMs: 150, ipRateLimitHits: 5 } })).toBe("poor");
  });

  it("isIpLimited is time-boxed", () => {
    const now = 1_000_000;
    expect(isIpLimited({ stats: { lastRateLimitAt: now - 1000 } }, now)).toBe(true);
    expect(isIpLimited({ stats: { lastRateLimitAt: now - IP_LIMIT_COOLDOWN_MS - 1 } }, now)).toBe(false);
    expect(isIpLimited({ stats: {} }, now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd libs/core-auth && npx vitest run src/proxy/scoring.test.ts`
Expected: FAIL — cannot find `./scoring.js`.

- [ ] **Step 3: Implement scoring.ts**

```ts
// @ts-nocheck
export const MAX_ACCOUNTS_PER_PROXY = 3;
export const IP_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

export function countAssignments(store, url) {
  return Object.values(store.assignments || {}).filter((u) => u === url).length;
}

// lower is better — IP-rate-limit hits dominate (they reflect a burned exit IP)
export function scoreOf(store, proxy) {
  const s = proxy.stats || {};
  const checks = s.checks || 0;
  const failRate = checks ? (s.failures || 0) / checks : 0.5;
  const inUse = countAssignments(store, proxy.url);
  return (s.avgLatencyMs || 2000) / 1000
    + failRate * 10
    + (s.ipRateLimitHits || 0) * 20
    + inUse * 5
    - (proxy.provider === "manual" ? 10 : 0);
}

// coarse UI quality from the same components (independent of assignment count)
export function qualityLabel(proxy) {
  const s = proxy.stats || {};
  const checks = s.checks || 0;
  const failRate = checks ? (s.failures || 0) / checks : 0.5;
  const q = (s.avgLatencyMs || 2000) / 1000 + failRate * 10 + (s.ipRateLimitHits || 0) * 20;
  if (q < 3) return "good";
  if (q < 12) return "fair";
  return "poor";
}

export function isIpLimited(proxy, now = Date.now()) {
  const at = proxy.stats && proxy.stats.lastRateLimitAt;
  return typeof at === "number" && now - at < IP_LIMIT_COOLDOWN_MS;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd libs/core-auth && npx vitest run src/proxy/scoring.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd libs/core-auth
git add src/proxy/scoring.ts src/proxy/scoring.test.ts
git commit -m "feat(proxy): extract scoring; add qualityLabel + time-boxed isIpLimited"
```

---

### Task 3: Scope resolution helpers

**Files:**
- Create: `libs/core-auth/src/proxy/scopes.ts`
- Test: `libs/core-auth/src/proxy/scopes.test.ts`

**Interfaces:**
- Consumes: store (Task 1), `scoreOf`/`countAssignments`/`isIpLimited`/`MAX_ACCOUNTS_PER_PROXY` (Task 2).
- Produces:
  - `scopeKey(scope)` → string; `parseScopeKey(key)` → `{type,id?}`.
  - `effectiveMode(store, key)` → `"disabled"|"manual"|"automatic"`.
  - `resolveChain(store, accountId, providerId)` → `string[]` of scopeKeys with effective mode ≠ disabled, ordered account→provider→global.
  - `proxiesInScope(store, key)` → proxies whose `scope` matches `key`.
  - `candidatesForScope(store, key, accountId, now?)` → usable proxies in that scope, best-first.

- [ ] **Step 1: Write the failing test**

```ts
// src/proxy/scopes.test.ts
import { describe, it, expect } from "vitest";
import { scopeKey, effectiveMode, resolveChain, candidatesForScope } from "./scopes.js";

function store(over = {}) {
  return { version: 2, modes: { default: "automatic" }, providers: {}, assignments: {}, manualSelection: {}, proxies: [], ...over };
}

describe("scopes", () => {
  it("scopeKey formats each scope type", () => {
    expect(scopeKey({ type: "global" })).toBe("global");
    expect(scopeKey({ type: "provider", id: "antigravity" })).toBe("provider:antigravity");
    expect(scopeKey({ type: "account", id: "a@b" })).toBe("account:a@b");
  });

  it("effectiveMode falls back to default", () => {
    const s = store({ modes: { default: "automatic", "global": "disabled" } });
    expect(effectiveMode(s, "global")).toBe("disabled");
    expect(effectiveMode(s, "account:x")).toBe("automatic");
  });

  it("resolveChain drops disabled scopes, most-specific first", () => {
    const s = store({ modes: { default: "automatic", "provider:p": "disabled" } });
    expect(resolveChain(s, "acc", "p")).toEqual(["account:acc", "global"]);
  });

  it("candidatesForScope excludes IP-limited + cap-bound, best-first", () => {
    const now = 1_000_000;
    const s = store({
      proxies: [
        { url: "slow", provider: "manual", scope: { type: "global" }, stats: { checks: 5, failures: 0, avgLatencyMs: 1500, ipRateLimitHits: 0 } },
        { url: "fast", provider: "manual", scope: { type: "global" }, stats: { checks: 5, failures: 0, avgLatencyMs: 100, ipRateLimitHits: 0 } },
        { url: "limited", provider: "manual", scope: { type: "global" }, stats: { lastRateLimitAt: now - 1000 } },
      ],
    });
    const urls = candidatesForScope(s, "global", "acc", now).map((p) => p.url);
    expect(urls).toEqual(["fast", "slow"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd libs/core-auth && npx vitest run src/proxy/scopes.test.ts`
Expected: FAIL — cannot find `./scopes.js`.

- [ ] **Step 3: Implement scopes.ts**

```ts
// @ts-nocheck
import { scoreOf, countAssignments, isIpLimited, MAX_ACCOUNTS_PER_PROXY } from "./scoring.js";

export function scopeKey(scope) {
  if (!scope || scope.type === "global") return "global";
  return scope.type + ":" + scope.id;
}
export function parseScopeKey(key) {
  if (key === "global") return { type: "global" };
  const i = key.indexOf(":");
  return { type: key.slice(0, i), id: key.slice(i + 1) };
}

export function effectiveMode(store, key) {
  const m = store.modes || {};
  return m[key] || m.default || "disabled";
}

// account -> provider -> global, dropping scopes whose effective mode is disabled
export function resolveChain(store, accountId, providerId) {
  const keys = [];
  if (accountId) keys.push("account:" + accountId);
  if (providerId) keys.push("provider:" + providerId);
  keys.push("global");
  return keys.filter((k) => effectiveMode(store, k) !== "disabled");
}

export function proxiesInScope(store, key) {
  return (store.proxies || []).filter((p) => scopeKey(p.scope) === key);
}

// usable proxies for a scope under its mode: manual = the scope's selected subset,
// automatic = all; minus cap-bound + currently IP-limited; sorted best-first.
export function candidatesForScope(store, key, accountId, now = Date.now()) {
  const mode = effectiveMode(store, key);
  let pool = proxiesInScope(store, key);
  if (mode === "manual") {
    const sel = new Set(store.manualSelection[key] || []);
    pool = pool.filter((p) => sel.has(p.url));
  }
  return pool
    .filter((p) => countAssignments(store, p.url) < MAX_ACCOUNTS_PER_PROXY && !isIpLimited(p, now))
    .sort((a, b) => scoreOf(store, a) - scoreOf(store, b));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd libs/core-auth && npx vitest run src/proxy/scopes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd libs/core-auth
git add src/proxy/scopes.ts src/proxy/scopes.test.ts
git commit -m "feat(proxy): scope-key + resolution-chain + scoped candidate helpers"
```

---

### Task 4: Rework ProxyManager (scoped selection, per-scope mode, ipSuspected)

**Files:**
- Modify: `libs/core-auth/src/proxy/manager.ts`
- Test: `libs/core-auth/src/proxy/manager.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces (public methods on `proxyManager`):
  - `selectForAccount(accountId, providerId)` → url|null (walks chain, sticky).
  - `pickForLogin(providerId)` → url|null (provider→global, no account scope).
  - `reportRateLimit(url, opts)` — penalizes only when `opts.ipSuspected === true`.
  - `reportResult(url, ok, latencyMs?)` — unchanged.
  - `addManual(url, scope)` — `scope` is a `{type,id?}` object (default `{type:"global"}`).
  - `remove(url)`; `getMode(key)`/`setMode(key,mode)`; `list()`; `proxiesForScope(key)`; `getScopeSelection(key)`/`setScopeSelection(key,urls)`; `providersConfig()`/`enableProvider()`/`refresh()` (refresh adds as global scope).
  - `bindAccountProxy(accountId, url)` (login stick — records under `account:<id>` selection when that scope is manual, else assignment only).

- [ ] **Step 1: Write the failing test**

```ts
// src/proxy/manager.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "proxytest-"));
  vi.stubEnv("HUB_CONFIG_DIR", dir);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

async function fresh() {
  vi.resetModules();
  return (await import("./manager.js")).proxyManager;
}

describe("ProxyManager scoped selection", () => {
  it("prefers account scope, falls through to global when account all IP-limited", async () => {
    const pm = await fresh();
    pm.setMode("default", "automatic");
    pm.addManual("http://acc", { type: "account", id: "a1" });
    pm.addManual("http://glob", { type: "global" });
    // first pick = account proxy
    expect(pm.selectForAccount("a1", "prov")).toBe("http://acc");
    // account proxy IP-limited -> next pick falls through to global
    pm.reportRateLimit("http://acc", { ipSuspected: true });
    expect(pm.selectForAccount("a1", "prov")).toBe("http://glob");
  });

  it("reportRateLimit does NOT penalize when ipSuspected is false", async () => {
    const pm = await fresh();
    pm.addManual("http://x", { type: "global" });
    pm.reportRateLimit("http://x", { ipSuspected: false });
    const p = pm.get("http://x");
    expect(p.stats.ipRateLimitHits || 0).toBe(0);
  });

  it("per-scope mode overrides default", async () => {
    const pm = await fresh();
    pm.setMode("default", "automatic");
    pm.setMode("provider:prov", "disabled");
    pm.addManual("http://provp", { type: "provider", id: "prov" });
    pm.addManual("http://glob", { type: "global" });
    // provider scope disabled -> skipped -> global chosen
    expect(pm.selectForAccount("a1", "prov")).toBe("http://glob");
  });
});
```

`setMode("default", ...)` sets `modes.default`; `setMode("provider:prov", ...)` sets that scope's override. `get(url)` returns the stored proxy (retained from today).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd libs/core-auth && npx vitest run src/proxy/manager.test.ts`
Expected: FAIL — `addManual`/`selectForAccount` signature mismatches / scope undefined.

- [ ] **Step 3: Implement manager.ts**

```ts
// @ts-nocheck
import { loadProxyStore, updateProxyStore } from "./store.js";
import { fetchEnabledProxies } from "./providers.js";
import { scoreOf, countAssignments, MAX_ACCOUNTS_PER_PROXY } from "./scoring.js";
import { scopeKey, effectiveMode, resolveChain, candidatesForScope, proxiesInScope } from "./scopes.js";

export class ProxyManager {
  load() { return loadProxyStore(); }

  getMode(key = "default") { return effectiveMode(this.load(), key); }
  setMode(key, mode) { updateProxyStore((s) => { s.modes = s.modes || { default: "disabled" }; s.modes[key] = mode; }); }

  enableProvider(name, on, key) {
    updateProxyStore((s) => { s.providers = s.providers || {}; s.providers[name] = { ...(s.providers[name] || {}), enabled: !!on, ...(key !== undefined ? { key } : {}) }; });
  }
  providersConfig() { return this.load().providers || {}; }

  // all proxies best-first, annotated with score + inUse (for the UI)
  list() {
    const store = this.load();
    return [...store.proxies].map((p) => ({ ...p, score: scoreOf(store, p), inUse: countAssignments(store, p.url) })).sort((a, b) => a.score - b.score);
  }
  proxiesForScope(key) {
    const store = this.load();
    return proxiesInScope(store, key).map((p) => ({ ...p, score: scoreOf(store, p), inUse: countAssignments(store, p.url) })).sort((a, b) => a.score - b.score);
  }
  get(url) { const store = this.load(); const p = store.proxies.find((x) => x.url === url); return p ? { ...p, score: scoreOf(store, p), inUse: countAssignments(store, p.url) } : null; }

  addManual(url, scope) {
    const clean = url.startsWith("http") ? url : "http://" + url;
    const sc = scope && scope.type ? scope : { type: "global" };
    updateProxyStore((s) => { if (!s.proxies.find((p) => p.url === clean)) s.proxies.push({ url: clean, provider: "manual", scope: sc, addedAt: Date.now(), stats: { checks: 0, failures: 0, avgLatencyMs: 0, ipRateLimitHits: 0, lastOkAt: 0 } }); });
    return clean;
  }
  remove(url) {
    updateProxyStore((s) => {
      s.proxies = s.proxies.filter((p) => p.url !== url);
      for (const [acc, u] of Object.entries(s.assignments)) if (u === url) delete s.assignments[acc];
      for (const key of Object.keys(s.manualSelection)) s.manualSelection[key] = (s.manualSelection[key] || []).filter((u) => u !== url);
    });
  }

  getScopeSelection(key) { return this.load().manualSelection[key] || []; }
  setScopeSelection(key, urls) { updateProxyStore((s) => { s.manualSelection[key] = urls; }); }

  // walk account -> provider -> global; sticky per account; fall through on empty/exhausted
  selectForAccount(accountId, providerId) {
    const store = this.load();
    const chain = resolveChain(store, accountId, providerId);
    if (!chain.length) return null;
    const current = store.assignments[accountId];
    // keep a sticky assignment only if it's still a usable candidate in some chain scope
    if (current) {
      for (const key of chain) if (candidatesForScope(store, key, accountId).some((p) => p.url === current)) return current;
    }
    for (const key of chain) {
      const cands = candidatesForScope(store, key, accountId);
      if (cands.length) { const chosen = cands[0].url; updateProxyStore((s) => { s.assignments[accountId] = chosen; }); return chosen; }
    }
    return null;
  }

  pickForLogin(providerId) {
    const store = this.load();
    const chain = resolveChain(store, null, providerId);   // no account scope yet
    for (const key of chain) { const cands = candidatesForScope(store, key, null); if (cands.length) return cands[0].url; }
    return null;
  }

  bindAccountProxy(accountId, url) {
    if (!url) return;
    updateProxyStore((s) => {
      const key = "account:" + accountId;
      if (effectiveMode(s, key) === "manual") {
        const sel = s.manualSelection[key] || [];
        if (!sel.includes(url)) sel.push(url);
        s.manualSelection[key] = sel;
      }
      s.assignments[accountId] = url;
    });
  }

  reportRateLimit(url, opts) {
    if (!opts || !opts.ipSuspected) return;   // only IP-suspected limits reflect proxy quality
    updateProxyStore((s) => {
      const p = s.proxies.find((x) => x.url === url);
      if (p) { p.stats = p.stats || {}; p.stats.ipRateLimitHits = (p.stats.ipRateLimitHits || 0) + 1; p.stats.lastRateLimitAt = Date.now(); }
      for (const [acc, u] of Object.entries(s.assignments)) if (u === url) delete s.assignments[acc];
    });
  }

  reportResult(url, ok, latencyMs) {
    updateProxyStore((s) => {
      const p = s.proxies.find((x) => x.url === url);
      if (!p) return;
      const st = p.stats = p.stats || { checks: 0, failures: 0, avgLatencyMs: 0, ipRateLimitHits: 0 };
      st.checks = (st.checks || 0) + 1;
      if (!ok) st.failures = (st.failures || 0) + 1;
      else { st.lastOkAt = Date.now(); if (typeof latencyMs === "number") st.avgLatencyMs = st.avgLatencyMs ? Math.round(st.avgLatencyMs * 0.7 + latencyMs * 0.3) : latencyMs; }
    });
  }

  async refresh() {
    const fetched = await fetchEnabledProxies(this.providersConfig());
    updateProxyStore((s) => {
      const have = new Set(s.proxies.map((p) => p.url));
      for (const f of fetched) if (!have.has(f.url)) { s.proxies.push({ url: f.url, provider: f.provider, scope: { type: "global" }, addedAt: Date.now(), stats: { checks: 0, failures: 0, avgLatencyMs: 0, ipRateLimitHits: 0, lastOkAt: 0 } }); have.add(f.url); }
    });
    return fetched.length;
  }
}

export const proxyManager = new ProxyManager();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd libs/core-auth && npx vitest run src/proxy/manager.test.ts`
Expected: PASS (3 tests). Then run the whole suite: `npx vitest run` — expect all proxy tests green.

- [ ] **Step 5: Build core-auth**

Run: `cd libs/core-auth && npm run build`
Expected: no tsc errors.

- [ ] **Step 6: Commit + push core-auth**

```bash
cd libs/core-auth
git add src/proxy/manager.ts src/proxy/manager.test.ts
git commit -m "feat(proxy): scoped selection hierarchy, per-scope mode, ipSuspected-gated penalty"
git push
```

---

### Task 5: Update the core-auth proxy UI helpers (menu-render path) + barrel

**Files:**
- Modify: `libs/core-auth/src/ui/proxy-menu.ts`
- Modify: `libs/core-auth/src/index.ts` (export new helpers if needed)

**Interfaces:**
- Consumes: Task 4 manager API.
- Produces: the standalone `runProxyMenu` / `selectAccountProxies` keep working against the new API (global scope + account scope), so `oc auth`'s non-loader menu doesn't break.

- [ ] **Step 1: Update call sites in proxy-menu.ts**

The old menu used `getMode()/setMode(mode)`, `byProvider()`, `addManual(url)`/`addManual(url, accountId)`, `getAccountSelection`/`setAccountSelection`, `accountProxies`. Map them to the new API:
- `proxyManager.getMode()` → `proxyManager.getMode("default")`.
- `proxyManager.setMode(m)` → `proxyManager.setMode("default", m)`.
- `proxyManager.byProvider()` → replace with `proxyManager.proxiesForScope("global")` (group header "Global").
- `proxyManager.addManual(url)` (global) → `proxyManager.addManual(url, { type: "global" })`.
- `proxyManager.addManual(url, accountId)` (account) → `proxyManager.addManual(url, { type: "account", id: accountId })`.
- `proxyManager.getAccountSelection(accountId)` → `proxyManager.getScopeSelection("account:" + accountId)`.
- `proxyManager.setAccountSelection(accountId, urls)` → `proxyManager.setScopeSelection("account:" + accountId, urls)`.
- `proxyManager.accountProxies(accountId)` → `[...proxyManager.proxiesForScope("global"), ...proxyManager.proxiesForScope("account:" + accountId)]`.

Apply each replacement in `libs/core-auth/src/ui/proxy-menu.ts` (lines 48, 68, 49, 69, 81, 82, 98, 99, 102 per current file).

- [ ] **Step 2: Build + run full core-auth suite**

Run: `cd libs/core-auth && npm run build && npx vitest run`
Expected: build clean; all tests pass.

- [ ] **Step 3: Commit + push**

```bash
cd libs/core-auth
git add src/ui/proxy-menu.ts src/index.ts
git commit -m "refactor(proxy-menu): use scoped ProxyManager API (default mode + global/account scopes)"
git push
```

Record the resulting core-auth SHA for Task 6/7 bumps: `git rev-parse --short HEAD`.

---

### Task 6: Wire providers to report ipSuspected + pass providerId

**Files:**
- Modify: `providers/antigravity-auth/src/driver/accounts-controller.ts` (add `accountHasQuota` export)
- Modify: `providers/antigravity-auth/src/driver/index.ts` (call sites)
- Modify: `providers/claude-code-auth/src/driver/accounts-controller.ts` (add `accountHasQuota` export)
- Modify: `providers/claude-code-auth/src/driver/index.ts` (call sites)
- Test: `providers/antigravity-auth/src/driver/accounts-controller.test.ts` (or extend an existing spec) + same for claude-code-auth
- Modify: both providers bump `core-auth` submodule to the Task 5 SHA.

**Interfaces:**
- Consumes: Task 4/5 `proxyManager.selectForAccount(accountId, providerId)`, `pickForLogin(providerId)`, `reportRateLimit(url, {ipSuspected})`.
- Produces: `accountHasQuota(account)` boolean per provider.

- [ ] **Step 1: Bump + build core-auth submodule in antigravity-auth**

```bash
cd providers/antigravity-auth
git -C core-auth fetch origin && git -C core-auth reset --hard <core-auth-sha-from-task-5>
(cd core-auth && npm run build)
```

- [ ] **Step 2: Write the failing antigravity quota test**

```ts
// providers/antigravity-auth/src/driver/accounts-controller.test.ts
import { describe, it, expect } from "vitest";
import { accountHasQuota } from "./accounts-controller.js";

describe("accountHasQuota (antigravity)", () => {
  it("true when any pool has remaining fraction > 0", () => {
    expect(accountHasQuota({ meta: { cachedQuota: { Gemini: { remainingFraction: 0.4 }, Claude: { remainingFraction: 0 } } } })).toBe(true);
  });
  it("false when all pools exhausted", () => {
    expect(accountHasQuota({ meta: { cachedQuota: { Gemini: { remainingFraction: 0 } } } })).toBe(false);
  });
  it("false when quota unknown", () => {
    expect(accountHasQuota({ meta: {} })).toBe(false);
    expect(accountHasQuota({})).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd providers/antigravity-auth && npx vitest run src/driver/accounts-controller.test.ts`
Expected: FAIL — `accountHasQuota` not exported.

- [ ] **Step 4: Add `accountHasQuota` to antigravity accounts-controller.ts**

```ts
// Quota still remaining? Used to decide a rate-limit is an IP limit (proxy signal),
// not real account exhaustion. Unknown quota -> false (never blame the proxy).
export function accountHasQuota(account) {
  const cq = account && account.meta && account.meta.cachedQuota;
  if (!cq) return false;
  return Object.values(cq).some((q) => q && typeof q.remainingFraction === "number" && q.remainingFraction > 0);
}
```

- [ ] **Step 5: Update antigravity driver/index.ts call sites**

- Import: add `accountHasQuota` to the existing `import { ... } from "./accounts-controller.js";` (check current imports; if none, add `import { accountHasQuota } from "./accounts-controller.js";`).
- Line ~156: `const proxyUrl = proxyManager.selectForAccount(account.id, PROVIDER_ID);`
- Line ~438 (fetchModels/verify path): same `selectForAccount(account.id, PROVIDER_ID)` (in accounts-controller.ts it uses `proxyManager.selectForAccount(id)` — update those to `selectForAccount(id, "antigravity")` too; or import PROVIDER_ID. Use the literal `"antigravity"` in accounts-controller.ts to avoid a circular import).
- Line ~213: replace
  ```ts
  if (proxyUrl) proxyManager.reportRateLimit(proxyUrl);   // possible IP rate-limit -> penalize the proxy
  ```
  with
  ```ts
  if (proxyUrl) {
    const fresh = manager.list().find((a) => a.id === account.id) || account;
    proxyManager.reportRateLimit(proxyUrl, { ipSuspected: accountHasQuota(fresh) });
  }
  ```

Also update the two `proxyManager.selectForAccount(id)` in `accounts-controller.ts` (lines ~95, ~168) to `proxyManager.selectForAccount(id, "antigravity")`.

- [ ] **Step 6: Run antigravity tests + build**

Run: `cd providers/antigravity-auth && npx vitest run && npm run build`
Expected: all pass (655 + 3 new), build clean.

- [ ] **Step 7: Commit + push antigravity-auth**

```bash
cd providers/antigravity-auth
git add core-auth src/driver/accounts-controller.ts src/driver/index.ts src/driver/accounts-controller.test.ts
git commit -m "feat(proxy): report ipSuspected on rate-limit (quota-remaining heuristic); pass providerId to proxy selection; bump core-auth"
git push
```

- [ ] **Step 8: Repeat for claude-code-auth**

Bump+build core-auth submodule (same SHA). Add to `claude-code-auth/src/driver/accounts-controller.ts`:

```ts
// Quota still remaining? (any unified pool below 100% utilization). Unknown -> false.
export function accountHasQuota(account) {
  const q = account && account.cachedQuota;
  const pools = q && q.pools;
  if (!pools) return false;
  return Object.values(pools).some((p) => p && typeof p.utilization === "number" && p.utilization < 1);
}
```

Test `providers/claude-code-auth/src/driver/accounts-controller.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { accountHasQuota } from "./accounts-controller.js";

describe("accountHasQuota (claude-code)", () => {
  it("true when a pool is below 100% utilization", () => {
    expect(accountHasQuota({ cachedQuota: { pools: { "5h": { utilization: 0.5 }, "7d": { utilization: 1 } } } })).toBe(true);
  });
  it("false when all pools maxed", () => {
    expect(accountHasQuota({ cachedQuota: { pools: { "5h": { utilization: 1 } } } })).toBe(false);
  });
  it("false when unknown", () => {
    expect(accountHasQuota({})).toBe(false);
  });
});
```

In `claude-code-auth/src/driver/index.ts`:
- Line ~100: `const proxyUrl = proxyManager.selectForAccount(account.id, "claude-code");`
- Line ~140: replace `if (proxyUrl) proxyManager.reportRateLimit(proxyUrl);` with
  ```ts
  if (proxyUrl) {
    const fresh = manager.list().find((a) => a.id === account.id) || account;
    proxyManager.reportRateLimit(proxyUrl, { ipSuspected: accountHasQuota(fresh) });
  }
  ```
- Import `accountHasQuota` from `./accounts-controller.js`.
- Update the `proxyManager.selectForAccount(...)` in `accounts-controller.ts` (refreshQuotaOne/verify) to pass `"claude-code"`.

Run: `cd providers/claude-code-auth && npx vitest run && npm run build`, then commit+push (same message shape).

- [ ] **Step 9: Update stub-auth (no quota concept)**

In `providers/stub-auth/src/driver/index.ts`, if it calls `proxyManager.selectForAccount`/`reportRateLimit`, pass `"stub"` and `{ ipSuspected: false }`. Bump core-auth submodule, build, commit+push. (If stub-auth doesn't use proxies, only the submodule bump + build is needed.)

---

### Task 7: Unified scope-tabbed Proxies view (core-loader)

**Files:**
- Create: `libs/core-loader/src/views/proxies.ts`
- Modify: `libs/core-auth/src/ui/menu-model.ts` (route the loader's in-tab proxy menu into the scoped view) — OR add the view via the loader's account-menu. Follow the existing `buildProxyMenu`/`buildProxyDetail` pattern in `menu-model.ts:25-49`.

**Interfaces:**
- Consumes: `proxyManager` methods from Task 4 (`proxiesForScope`, `getMode`/`setMode` per scope key, `addManual(url, scope)`, `remove`, `getScopeSelection`/`setScopeSelection`, `qualityLabel` via `list()`/`get()` — expose `qualityLabel` through the barrel).
- Produces: an in-tab menu model with a scope selector, per-scope mode cycle, add/remove/select, and quality + IP-limit columns.

- [ ] **Step 1: Export `qualityLabel` from core-auth barrel**

In `libs/core-auth/src/index.ts` add: `export { qualityLabel } from "./proxy/scoring.js";`. Build core-auth, commit, push, note SHA.

- [ ] **Step 2: Rewrite `buildProxyMenu`/`buildProxyDetail` in menu-model.ts as a scoped view**

Replace the existing `buildProxyMenu` (menu-model.ts:32-49) with a scope-aware builder. Full implementation:

```ts
// module-scope: which scope the proxy view is focused on
let proxyScopeKey = "global";

function proxyScopeLabel(key) {
  if (key === "global") return "Global (all providers)";
  const i = key.indexOf(":");
  return (key.slice(0, i) === "provider" ? "Provider: " : "Account: ") + key.slice(i + 1);
}

// scope keys offered in the selector: global + every logged-in provider + every account
function proxyScopeKeys(def) {
  const keys = ["global"];
  if (def && def.id) keys.push("provider:" + def.id);
  try { for (const v of (def.accounts.list ? def.accounts.list() : [])) keys.push("account:" + v.id); } catch {}
  return keys;
}

function buildProxyMenu(def) {
  const keys = proxyScopeKeys(def);
  if (!keys.includes(proxyScopeKey)) proxyScopeKey = "global";
  const mode = proxyManager.getMode(proxyScopeKey);
  const items = [
    { label: "Back", run: () => ({ pop: true }) },
    { label: "Scope: " + proxyScopeLabel(proxyScopeKey), color: "cyan", run: () => { const i = keys.indexOf(proxyScopeKey); proxyScopeKey = keys[(i + 1) % keys.length]; return { refresh: true }; } },
    { label: "Mode: " + mode, color: "cyan", run: () => { const order = ["automatic", "manual", "disabled"]; const i = order.indexOf(mode); proxyManager.setMode(proxyScopeKey, order[(i + 1) % order.length]); return { refresh: true }; } },
    { label: "Add proxy to this scope", color: "green", run: () => ({ input: { title: "Proxy URL", message: "host:port or http://...", complete: (url) => { if (url) proxyManager.addManual(url, parseScopeForKey(proxyScopeKey)); return { refresh: true }; } } }) },
    { label: "Refresh from providers (global)", color: "cyan", run: async () => { let msg; try { const n = await proxyManager.refresh(); msg = "Fetched " + n; } catch (e) { msg = "Failed: " + (e && e.message || e); } return { refresh: true, flash: msg }; } },
    { label: "", separator: true },
  ];
  const sel = new Set(proxyManager.getScopeSelection(proxyScopeKey));
  const rows = proxyManager.proxiesForScope(proxyScopeKey);
  items.push({ label: proxyScopeLabel(proxyScopeKey) + " proxies (" + rows.length + ")", kind: "heading" });
  if (!rows.length) items.push({ label: "None — add one above.", kind: "note" });
  for (const p of rows) {
    const q = qualityLabel(p);
    const ipHits = (p.stats && p.stats.ipRateLimitHits) || 0;
    const tick = mode === "manual" ? (sel.has(p.url) ? "[x] " : "[ ] ") : "";
    const hint = "quality " + q + " · in-use " + (p.inUse || 0) + (ipHits ? " · " + ipHits + " IP-limits" : "");
    items.push({ label: tick + p.url, hint, run: () => ({ push: () => buildProxyDetail(p.url, proxyScopeKey) }) });
  }
  // wider scopes shown read-only so you can see the fall-through path
  if (proxyScopeKey !== "global") {
    const glob = proxyManager.proxiesForScope("global");
    if (glob.length) { items.push({ label: "", separator: true }); items.push({ label: "Falls through to Global (" + glob.length + ", read-only)", kind: "heading" }); for (const p of glob) items.push({ label: p.url, hint: "quality " + qualityLabel(p), kind: "note" }); }
  }
  return { title: "Proxies", subtitle: "Scope: " + proxyScopeLabel(proxyScopeKey) + " · mode " + mode, items };
}

function parseScopeForKey(key) {
  if (key === "global") return { type: "global" };
  const i = key.indexOf(":");
  return { type: key.slice(0, i), id: key.slice(i + 1) };
}

function buildProxyDetail(url, scopeKey) {
  const sel = new Set(proxyManager.getScopeSelection(scopeKey));
  const mode = proxyManager.getMode(scopeKey);
  const items = [
    { label: "Back", run: () => ({ pop: true }) },
  ];
  if (mode === "manual") items.push({ label: sel.has(url) ? "Deselect (manual)" : "Select (manual)", color: "cyan", run: () => { if (sel.has(url)) sel.delete(url); else sel.add(url); proxyManager.setScopeSelection(scopeKey, [...sel]); return { refresh: true }; } });
  items.push({ label: "Remove", color: "red", run: () => ({ push: () => buildConfirmMenu("Remove " + url + "?", () => proxyManager.remove(url)) }) });
  return { title: url, items };
}
```

Add the import at the top of `menu-model.ts`: `import { qualityLabel } from "../leaderboard.js";` → NO. Add `import { qualityLabel } from "../proxy/scoring.js";` (or reference the barrel). Verify `parseScopeForKey`/`buildConfirmMenu` are in scope (`buildConfirmMenu` already exists from an earlier change).

- [ ] **Step 3: Build core-auth, run suite, commit, push**

```bash
cd libs/core-auth && npm run build && npx vitest run
git add src/ui/menu-model.ts src/index.ts && git commit -m "feat(ui): scope-tabbed proxy view (global/provider/account) with quality + IP-limit columns"
git push
```

Note the new core-auth SHA.

---

### Task 8: Propagate to all consumers, redeploy, verify

**Files:**
- Modify: `core-auth` submodule pointer in `providers/antigravity-auth`, `providers/claude-code-auth`, `providers/stub-auth` (Task 6 already bumped; re-bump to the Task 7 SHA).
- No loader submodule change needed unless core-loader itself changed (it did not — the view lives in core-auth's menu-model). If any core-loader change was made, bump it in both loaders.

- [ ] **Step 1: Bump core-auth to the final SHA in all three providers**

For each of antigravity-auth, claude-code-auth, stub-auth:
```bash
cd providers/<p>
git -C core-auth fetch origin && git -C core-auth reset --hard <task7-core-auth-sha>
(cd core-auth && npm run build)
npm run build && npx vitest run
git add core-auth && git commit -m "chore: bump core-auth -> <sha> (scoped proxies + proxy view)" && git push
```

- [ ] **Step 2: Redeploy the live clones (both homes)**

```bash
for base in "$HOME/.claude/repos" "$HOME/.config/opencode/repos"; do
  for p in antigravity-auth claude-code-auth stub-auth; do
    cd "$base/$p" 2>/dev/null || continue
    BR=$(git remote show origin | sed -n 's/.*HEAD branch: //p')
    git fetch origin && git reset --hard "origin/$BR"
    git submodule update --init --recursive
    git submodule foreach --recursive 'git reset --hard' 
    npm install --no-audit --no-fund && npm rebuild esbuild && npm run build
  done
done
```

- [ ] **Step 3: Verify the deployed bundle carries the new logic**

```bash
grep -c "ipSuspected" "$HOME/.claude/repos/antigravity-auth/dist/handler.js"
grep -c "resolveChain\|candidatesForScope" "$HOME/.claude/repos/antigravity-auth/dist/handler.js"
```
Expected: both > 0.

- [ ] **Step 4: Live behavior check (migration + selection)**

```bash
node --input-type=module -e "
process.env.HUB_CONFIG_DIR='C:/Users/finn/.claude';
const { proxyManager } = await import('file:///C:/Users/finn/.claude/repos/antigravity-auth/dist/handler.js').then(m=>m).catch(()=>({}));
"
```
If the handler doesn't re-export proxyManager, instead confirm the existing `config/core-auth-proxies.json` (if present) loads without error by launching the loader TUI → Providers → a provider → Proxies, and confirm the scope selector cycles Global/Provider/Account and existing proxies still appear (migrated to global/account scope).

- [ ] **Step 5: Update memory**

Append to `~/.claude/projects/F--Documents-GitHub/memory/` a note on the scoped proxy model (scope tags, resolveChain precedence, ipSuspected gate, IP_LIMIT_COOLDOWN_MS) and link it from MEMORY.md.

---

## Self-Review

**Spec coverage:**
- Resolution hierarchy account→provider→global→direct → Tasks 3 (`resolveChain`) + 4 (`selectForAccount`). ✓
- One tagged pool + v1→v2 migration → Task 1. ✓
- Per-scope mode with default fallback → Tasks 1 (store), 3 (`effectiveMode`), 4 (`get/setMode`). ✓
- IP-limited window (5 min) → Task 2 (`isIpLimited`) + 3 (candidate exclusion). ✓
- Provider reports ipSuspected (antigravity: pool>0; claude-code: utilization<1) → Task 6. ✓
- Fall-through on empty/exhausted → Task 4 `selectForAccount` loop + Task 3 candidate filter. ✓
- Unified scope-tabbed UI, old entries route in → Task 7. ✓
- Signature changes (`selectForAccount(id,providerId)`, `pickForLogin(providerId)`, `reportRateLimit(url,{ipSuspected})`) → Tasks 4, 6. ✓
- Testing (migration, chain, mode override, ipSuspected gate, provider quota tests) → Tasks 1–6. ✓
- Rollout → Task 8. ✓

**Placeholder scan:** none — every code step has full code; the one conditional ("if stub-auth uses proxies") gives the exact fallback action.

**Type consistency:** scope object `{type,id?}`; scope key strings `global`/`provider:<id>`/`account:<id>`; `reportRateLimit(url,{ipSuspected})`; `selectForAccount(accountId,providerId)`; `getMode(key)`/`setMode(key,mode)`; `getScopeSelection`/`setScopeSelection(key,...)`; `qualityLabel(proxy)`; `accountHasQuota(account)` — consistent across Tasks 1–7.
