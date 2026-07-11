# Proxy rework — scoped proxies + IP-rate-limit quality signal

Status: design approved 2026-07-11. Next step: writing-plans → implementation.

## Context

Today's proxy system (`libs/core-auth/src/proxy/`) has one shared pool, two implicit
tiers (global = no `owner`, account = `owner === accountId`), a single global
`mode` (disabled/manual/automatic), and score-based selection
(latency + fail-rate + IP-limit-hits + in-use). Two problems:

1. **No per-provider tier.** You can't say "route antigravity through these proxies
   but leave claude-code direct." The user wants full control at three scopes:
   global (all providers), per-provider, per-account.
2. **The IP-rate-limit signal is too eager.** `proxyManager.reportRateLimit(url)`
   fires on *every* account 429, even genuine quota exhaustion, wrongly penalizing
   the proxy. The real signal: **rate-limited while quota remains ⇒ it's an IP
   limit ⇒ that reflects proxy quality.** This must work for all providers.

Outcome: three proxy scopes with a clear precedence, per-scope mode, an
IP-limit-aware quality signal that only blames proxies when the account still has
quota, and one unified TUI view to control it all.

## Decisions (user-confirmed)

- **Resolution hierarchy**, most-specific wins: account → provider → global → direct.
- **One tagged pool** (extend today's `owner` into a `scope` tag), not separate pools.
- **Provider decides `ipSuspected`** and reports it; core-auth never guesses from headers.
- **Fall through** to the next scope when the current scope is empty *or* all its
  proxies are exhausted (IP-limited / cap-bound).
- **Per-scope mode** with a `default` fallback (migrated from the old single mode).
- **One Proxies view with scope tabs** in core-loader; old entry points route into it.

## Architecture — core-auth (`libs/core-auth/src/proxy/`)

### Store (`store.ts`)
`core-auth-proxies.json` shape becomes:
```
{
  version: 2,
  modes: { default: "disabled"|"manual"|"automatic",
           "global"?: mode, "provider:<id>"?: mode, "account:<id>"?: mode },
  proxies: [ { url, provider (source: manual|<fetch-provider>),
               scope: {type:"global"} | {type:"provider", id} | {type:"account", id},
               addedAt, stats: {checks,failures,avgLatencyMs,ipRateLimitHits,lastOkAt,lastRateLimitAt} } ],
  assignments: { "<accountId>": url },
  manualSelection: { "<scopeKey>": [url] },   // scopeKey = "global" | "provider:<id>" | "account:<id>"
  providers: { <fetch-provider>: {enabled,key} }   // unchanged (proxy SOURCES, not scopes)
}
```
**Migration v1→v2** (in `loadProxyStore`): `owner` → `scope:{type:"account",id:owner}`
else `scope:{type:"global"}`; old top-level `mode` → `modes.default`; old
`manualSelection[accountId]` → `manualSelection["account:"+accountId]`. Idempotent;
writes v2 back on next save.

> Note: `provider` on a proxy is its SOURCE (manual vs a fetch provider like a proxy
> list), an existing field — distinct from `scope.type==="provider"`, which is the
> new per-provider assignment. Keep both; don't conflate.

### Scope resolution (`scopes.ts`, new)
- `scopeKey(scope)` → `"global"` | `"provider:<id>"` | `"account:<id>"`.
- `effectiveMode(store, scopeKey)` → `modes[scopeKey] ?? modes.default`.
- `resolveChain(accountId, providerId)` → ordered scopeKeys
  `["account:<id>", "provider:<id>", "global"]`, filtering out scopes whose
  effective mode is `disabled`.
- `candidatesForScope(store, scopeKey, accountId)` → proxies tagged to that scope,
  filtered by mode (`manual` = the scope's `manualSelection` subset; `automatic` =
  all), excluding cap-bound (`countAssignments >= MAX_ACCOUNTS_PER_PROXY`) and
  **currently IP-limited**, sorted best-score-first.
- **IP-limited window**: a proxy counts as "currently IP-limited" (and thus
  exhausted, triggering fall-through) when `Date.now() - stats.lastRateLimitAt <
  IP_LIMIT_COOLDOWN_MS`, default **5 min**. This time-boxed exclusion is what makes
  "all proxies in a scope exhausted → fall through" real; after the window the proxy
  re-enters candidacy (still ranked lower by its accumulated `ipRateLimitHits`, so it
  self-heals if it was a fluke and stays deprioritized if chronically bad). In
  `manual` mode a scope with all-IP-limited proxies also falls through — manual
  constrains *which* proxies, not whether fall-through happens.

### Scoring (`scoring.ts`, new — moved out of manager)
`scoreOf(store, proxy)` unchanged in shape; add `qualityLabel(proxy)` deriving a
coarse good/fair/poor (or ●●●○) from the same components for the UI. IP-limit hits
remain the dominant negative term so they drive both ranking and the visible quality.

### Manager (`manager.ts`)
- `selectForAccount(accountId, providerId)` — walk `resolveChain`, return the first
  usable candidate across scopes (fall through on empty/all-exhausted); sticky via
  `assignments`; `null` when every scope is disabled/empty → direct.
- `pickForLogin(providerId)` — same walk with no account scope (account doesn't
  exist yet): `provider:<id>` then `global`.
- `reportRateLimit(url, { ipSuspected })` — only increments `ipRateLimitHits` +
  `lastRateLimitAt` and frees the assignment when `ipSuspected === true`; otherwise
  a no-op for proxy quality (the account manager still records the account-level
  limit separately, as today).
- `reportResult`, `addManual`, `remove`, `refresh` gain scope-awareness
  (`addManual(url, scope)`; `remove` clears assignments + every scope's
  manualSelection). Per-scope mode getters/setters: `getMode(scopeKey)` /
  `setMode(scopeKey, mode)`; `list()` / grouping helpers filter by scope.

### Provider contract (`providers/*/src/driver/index.ts`)
- Replace `proxyManager.selectForAccount(account.id)` with
  `proxyManager.selectForAccount(account.id, PROVIDER_ID)` (and `pickForLogin(PROVIDER_ID)`).
- Replace the unconditional `proxyManager.reportRateLimit(proxyUrl)` with
  `proxyManager.reportRateLimit(proxyUrl, { ipSuspected: <quota-remains?> })`:
  - **antigravity**: quota remains if any `account.meta.cachedQuota[pool].remainingFraction > 0`
    (or cachedQuota absent → unknown → `false`, don't blame).
  - **claude-code**: quota remains if `cachedQuota.pools` has any bucket with
    `utilization < 1` (absent → `false`).
- stub-auth: passes `ipSuspected:false` (no quota concept) — still compiles.

## Architecture — core-loader (`libs/core-loader/src/`)

New `views/proxies.ts` renderer + input handling: a single Proxies view with a
**scope selector** (Global · Provider:<name> · Account:<email>), the active scope's
**mode** (key-cycled), **Add proxy / Add from providers** actions, and proxy rows
showing URL, **quality** indicator, in-use count, explicit IP-limit count, and (manual
mode) a `[x]` select toggle. Narrower scopes show the wider scopes' proxies read-only
(what a request falls through to). The existing "Manage proxies" and per-account
"Select proxies" entries route into this view (the latter pre-focused on the account
scope). Consumed by both loaders; providers untouched by UI.

## Error handling / edge cases

- Effective mode falls back to `modes.default`; migration sets `default` = old mode,
  preserving current behavior on first load.
- Selection sticky per account; freed on `ipSuspected` limit so the next request
  rotates away from a bad proxy.
- `ipSuspected` false/unknown never penalizes proxy quality.
- Remove cleans assignments + all manualSelection scopes.
- All scopes disabled/empty → direct (unchanged from today's `disabled`).

## Testing

- **core-auth unit**: v1→v2 migration; `resolveChain` precedence + disabled-scope
  skip; fallthrough (account all-exhausted → provider → global → direct); per-scope
  mode override vs default; `reportRateLimit` penalizes only when `ipSuspected`.
- **provider unit**: 429-with-quota → `ipSuspected:true`; 429-without/unknown-quota
  → `false`, for antigravity and claude-code.
- **loader**: existing contract kit (renders without throwing) + manual TUI check of
  the scope-tabbed view in a deployed clone.

## Rollout

core-auth change → build/push → bump submodule in all three providers + both loaders
→ rebuild → redeploy the live clones (both homes) → grep deployed `dist` → verify a
live request still routes and a with-quota 429 marks the proxy.

## Out of scope

- Proxy health pre-checking / active probing (keep passive stats).
- Fetching new proxy sources (unchanged `providers`/`refresh`).
- The config-git work (parked separately).
