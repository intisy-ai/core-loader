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

// Loads a handler's provider metadata for consumers that only need the def(s), not
// the request-handling side of the module (e.g. Cairn listing providers). Supports
// three export shapes, checked in order, and never throws: a failed import or a
// handler exporting none of these shapes both resolve to [].
export async function loadProviderDefs(handlerPath: string): Promise<ProviderDef[]> {
  let mod: any;
  try {
    mod = await import(pathToFileURL(handlerPath).href);
  } catch {
    return [];
  }

  let raw: unknown[] = [];
  if (Array.isArray(mod.defs)) {
    raw = mod.defs;
  } else if (typeof mod.resolveProviders === "function") {
    try {
      raw = await mod.resolveProviders();
      if (!Array.isArray(raw)) raw = [];
    } catch {
      raw = [];
    }
  } else if (mod.def && typeof mod.def === "object") {
    raw = [mod.def];
  }

  const out: ProviderDef[] = [];
  for (const entry of raw) {
    const normalized = normalizeProviderDef(entry);
    if (normalized) out.push(normalized);
  }
  return out;
}
