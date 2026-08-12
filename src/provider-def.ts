// Provider metadata contract every provider handler's `def` export satisfies. A
// single handler module can expose more than one of these (see loadProviderDefs)
// so one plugin can back several providers, optionally sharing one account pool.
import { pathToFileURL } from "node:url";

export interface ProviderDef {
  id: string;
  label: string;
  models: Record<string, unknown>;
  hasOAuth: boolean;
  settings?: unknown;
  translator?: string;
  // Account store key. Several providers (e.g. antigravity + gemini-cli) can share
  // one pool by declaring the same accountPool; defaults to `id` when absent.
  accountPool?: string;
}

// Coerces a raw export into a ProviderDef, dropping anything missing the required
// id/label fields. Never throws.
function normalizeProviderDef(raw: unknown): ProviderDef | null {
  if (!raw || typeof raw !== "object") return null;
  const def = raw as Record<string, unknown>;
  if (typeof def.id !== "string" || typeof def.label !== "string") return null;
  return {
    id: def.id,
    label: def.label,
    models: (def.models && typeof def.models === "object" ? def.models : {}) as Record<string, unknown>,
    hasOAuth: !!def.hasOAuth,
    settings: def.settings,
    translator: typeof def.translator === "string" ? def.translator : undefined,
    accountPool: typeof def.accountPool === "string" ? def.accountPool : def.id,
  };
}

export interface ProviderDefsResult {
  defs: ProviderDef[];
  error?: string;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Loads a handler's provider metadata for consumers that only need the def(s), not
// the request-handling side of the module (e.g. Cairn listing providers). Supports
// three export shapes, checked in order: `defs` array, `resolveProviders()`, `def`
// object. A handler exporting none of these legitimately has no defs, not an error.
// `error` is a string (not an Error) because it crosses a process boundary to a
// renderer as JSON, and carries the underlying failure's own message so a UI row
// can name what broke.
export async function loadProviderDefsResult(handlerPath: string): Promise<ProviderDefsResult> {
  let mod: any;
  try {
    mod = await import(pathToFileURL(handlerPath).href);
  } catch (err) {
    return { defs: [], error: `Failed to load provider handler: ${messageOf(err)}` };
  }

  let raw: unknown[] = [];
  if (Array.isArray(mod.defs)) {
    raw = mod.defs;
  } else if (typeof mod.resolveProviders === "function") {
    try {
      const resolved = await mod.resolveProviders();
      raw = Array.isArray(resolved) ? resolved : [];
    } catch (err) {
      return { defs: [], error: `resolveProviders() failed: ${messageOf(err)}` };
    }
  } else if (mod.def && typeof mod.def === "object") {
    raw = [mod.def];
  }

  const defs: ProviderDef[] = [];
  for (const entry of raw) {
    const normalized = normalizeProviderDef(entry);
    if (normalized) defs.push(normalized);
  }
  return { defs };
}

// Kept for callers that only want the defs and never handled `error`; never throws
// and returns [] on any failure, matching its behavior before loadProviderDefsResult existed.
export async function loadProviderDefs(handlerPath: string): Promise<ProviderDef[]> {
  return (await loadProviderDefsResult(handlerPath)).defs;
}
