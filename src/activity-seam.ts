// The write side of Activity, injected. core-loader bundles no core, so the host
// loader (which does) installs emit/scope/env once and everything here forwards to
// it; unset, every helper is a no-op, so the TUI works with Activity absent. The
// read side stays on S.capabilities.activity.read, where the views need it.

export type LoaderCause = { kind: string; surface?: string; detail?: string };

export type LoaderActivitySeam = {
  emit?: (spec: Record<string, unknown>) => void;
  scope?: <T>(cause: LoaderCause, fn: () => T) => T;
  env?: () => Record<string, string>;
};

let SEAM: LoaderActivitySeam = {};

export function setActivitySeam(seam: LoaderActivitySeam | null | undefined): void {
  SEAM = seam && typeof seam === "object" ? seam : {};
}

export function emitLoaderActivity(spec: Record<string, unknown>): void {
  try { SEAM.emit?.(spec); } catch { /* activity is never worth breaking an action for */ }
}

// A broken scope must never cost the caller its action or its result. If the scope
// throws before the action ran, run it unscoped. If it throws after, the action
// already succeeded, so return what the action produced and drop the seam's error.
// Only an error from the action itself reaches the caller. The action's own return
// value is always what comes back, never the scope's.
// The scope contract, which the recovery below relies on: invoke fn synchronously,
// exactly once. A scope that returns without invoking it at all gets the action run
// unscoped rather than silently skipped. A scope that defers fn past its own return
// breaks that contract and would run the action twice, which is why the contract is
// synchronous: establishing an async-context scope requires calling fn inline anyway.
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

export function loaderActivityEnv(): Record<string, string> {
  try {
    const env = SEAM.env?.();
    return env && typeof env === "object" ? env : {};
  } catch { return {}; }
}

// Startup coverage: the host app loaded this plugin. The caller passes its own name,
// so this module names nothing.
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
