// config-ledger delegation: dynamically import the plugin's dist/lib.js when present,
// return null when absent. Mirrors src/updater.ts (preloadUpdater/getUpdater) and
// plugin-updater's syncbridge.ts resolver. Loaders delegate; hide features if absent.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG_DIR, REPOS_DIR, tuiLog } from "./env.js";
import { S } from "./state.js";

// NUL separator: no config file name or dotted key ever contains a NUL byte.
const SEP = String.fromCharCode(0);

// The plugin clone (not the data repo) holds the library entry point.
export function resolveConfigLedgerLib(): string | null {
  const p = join(REPOS_DIR, "config-ledger", "dist", "lib.js");
  return existsSync(p) ? p : null;
}

export async function preloadConfigLedger(): Promise<void> {
  const libPath = resolveConfigLedgerLib();
  if (!libPath) { tuiLog("config-ledger not installed; git settings features disabled"); return; }
  // Pin config-ledger to the same app home the loader manages.
  process.env.HUB_CONFIG_DIR = CONFIG_DIR;
  try {
    const mod: any = await import(pathToFileURL(libPath).href);
    if (typeof mod.diffAgainstHead !== "function" || !mod.repo || typeof mod.repo.isRepo !== "function") {
      tuiLog("config-ledger lib present but missing expected exports (older version); disabling", true);
      return;
    }
    S.CONFIG_LEDGER_MODULE = mod;
  } catch (e: any) {
    tuiLog("config-ledger lib import failed: " + ((e && e.message) || e), true);
  }
}

export function getConfigLedger(): any | null {
  return S.CONFIG_LEDGER_MODULE;
}

export function configLedgerInstalled(): boolean {
  return !!S.CONFIG_LEDGER_MODULE;
}

export function configLedgerReady(): boolean {
  const m = S.CONFIG_LEDGER_MODULE;
  if (!m) return false;
  try { return m.repo.isRepo() === true; } catch { return false; }
}

// --- pure helpers (unit-tested) ---
export function diffKeyId(file: string, key: string): string {
  return file + SEP + key;
}

export function buildDiffSet(rows: Array<{ file: string; key: string }>): Set<string> {
  const set = new Set<string>();
  for (const r of rows || []) set.add(diffKeyId(r.file, r.key));
  return set;
}
