// The write side of Activity, injected, and it must stay injected even though this library now
// reads core directly: core keeps the activity context in MODULE state (an ambient context object
// and an AsyncLocalStorage for cause scopes), and the host is what installs it. Taking core's
// emitter here instead would bind these calls to whichever core copy this package resolves, which
// in a tree where each package has its own is a different instance from the one the host set the
// context on, so every record would carry an empty origin and no cause. Unset, every helper is a
// no-op, so the TUI works with Activity absent. The read side stays on
// S.capabilities.activity.read, where the views need it.

import type { ActivitySpec, Cause } from "@intisy-ai/core";

/**
 * Why something happened, carried down a scope so every record inside it inherits the same reason.
 *
 * @remarks
 * Core's own `Cause`, not a copy of it: the host that installs the seam records through core, so a
 * looser shape here would only be caught at the boundary, by whichever loader typed itself first.
 */
export type LoaderCause = Cause;

/** The write side of Activity, as the host injects it. Every member absent means Activity is simply off. */
export type LoaderActivitySeam = {
  /** Records one activity. */
  emit?: (spec: ActivitySpec) => void;
  /**
   * Runs something inside a cause, so every record it makes inherits that reason.
   *
   * @remarks
   * The contract is synchronous: invoke `fn` inline, exactly once. A scope that defers it would
   * have the action run twice, because a scope that never invokes it has the action run unscoped.
   */
  scope?: <T>(cause: LoaderCause, fn: () => T) => T;
  /** The environment a child process needs to join the current chain. */
  env?: () => Record<string, string>;
};

let SEAM: LoaderActivitySeam = {};

/** Installs the seam the host supplied, or clears it. */
export function setActivitySeam(seam: LoaderActivitySeam | null | undefined): void {
  SEAM = seam && typeof seam === "object" ? seam : {};
}

/** Records one activity, and never throws: Activity is not worth breaking an action for. */
export function emitLoaderActivity(spec: ActivitySpec): void {
  try { SEAM.emit?.(spec); } catch { /* activity is never worth breaking an action for */ }
}

/**
 * A broken scope must never cost the caller its action or its result. If the scope
 * throws before the action ran, run it unscoped. If it throws after, the action
 * already succeeded, so return what the action produced and drop the seam's error.
 * Only an error from the action itself reaches the caller. The action's own return
 * value is always what comes back, never the scope's.
 * The scope contract, which the recovery below relies on: invoke fn synchronously,
 * exactly once. A scope that returns without invoking it at all gets the action run
 * unscoped rather than silently skipped. A scope that defers fn past its own return
 * breaks that contract and would run the action twice, which is why the contract is
 * synchronous: establishing an async-context scope requires calling fn inline anyway.
 */
export function withLoaderCause<T>(cause: LoaderCause, fn: () => T): T {
  const scope = SEAM.scope;
  if (typeof scope !== "function") return fn();
  let ran = false;
  let threw = false;
  let value: T | undefined;
  let error: unknown;
  const run = () => {
    ran = true;
    try { value = fn(); return value; }
    catch (e) { threw = true; error = e; throw e; }
  };
  try { scope(cause, run); } catch { /* the seam's own failure is not the caller's */ }
  if (threw) throw error;
  if (!ran) return fn();
  return value as T;
}

/** The environment a child process needs to join this activity's chain. */
export function loaderActivityEnv(): Record<string, string> {
  try {
    const env = SEAM.env?.();
    return env && typeof env === "object" ? env : {};
  } catch { return {}; }
}

/**
 * The environment for a child process we start: the caller's own additions first, then
 * the activity trace, which must win so a child joins the chain that started it. One
 * helper rather than the same spread at five call sites, so a real spawned-child test
 * covers every one of them.
 */
export function spawnEnv(extra?: Record<string, string>): Record<string, string> {
  return { ...process.env, ...(extra || {}), ...loaderActivityEnv() } as Record<string, string>;
}

/**
 * Startup coverage: the host app loaded this plugin. The caller passes its own name,
 * so this module names nothing.
 */
export function emitPluginActivated(pluginName: string, details?: Record<string, unknown>): void {
  emitLoaderActivity({
    topic: "plugin.activated",
    action: "activated",
    impact: "info",
    actor: "app",
    cause: { kind: "startup" },
    subject: { kind: "plugin", id: pluginName, label: pluginName },
    details: details || {},
  });
}
