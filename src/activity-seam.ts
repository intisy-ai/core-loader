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

// A broken scope must not swallow the action: if it throws before the action ran,
// run it unscoped; once the action has run, its own error belongs to the caller.
export function withLoaderCause<T>(cause: LoaderCause, fn: () => T): T {
  const scope = SEAM.scope;
  if (typeof scope !== "function") return fn();
  let ran = false;
  try {
    return scope(cause, () => { ran = true; return fn(); });
  } catch (e) {
    if (ran) throw e;
    return fn();
  }
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
