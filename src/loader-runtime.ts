// @ts-nocheck
// Shared activation helpers for BOTH loaders' plugin.ts (claude-code-loader,
// opencode-loader). Kept core-free — the caller injects its own logger — so
// core-loader stays independent of the core bundle.

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { pathToFileURL } from "url";

export function getBinDir() {
  return join(homedir(), ".local", "bin");
}

// Resolve plugin-updater: bare specifier first, then known install locations.
export async function loadUpdater(): Promise<any> {
  try {
    return await import("plugin-updater");
  } catch {
    // opencode installs npm plugins into its package cache, off the deployed
    // plugin's resolution path; this candidate is simply absent under Claude.
    const candidates = [
      join(homedir(), ".cache", "opencode", "packages", "plugin-updater@latest", "node_modules", "plugin-updater", "dist", "index.js"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return await import(pathToFileURL(candidate).href);
    }
    throw new Error("plugin-updater not resolvable");
  }
}

// Run plugin-updater's earlyLaunch on activation. `log(message)` is the caller's
// per-plugin logger; skipped when we're already inside a plugin-updater run.
export async function runEarlyLaunchHooks(configDir: string, log: (message: string) => void) {
  if (process.env.PLUGIN_UPDATER_ACTIVATION === "1") {
    log("Updates driven by plugin-updater (activation context), skipping earlyLaunch");
    return;
  }
  try {
    const updater: any = await loadUpdater();
    const gitPlugins = updater.getPlugins(configDir);
    log("Running plugin-updater earlyLaunch for " + gitPlugins.length + " plugins");
    await updater.earlyLaunch(configDir, gitPlugins);
    log("plugin-updater earlyLaunch complete");
  } catch (e) {
    log("plugin-updater not available, skipping updates: " + e);
  }
}

export function ensureBinDir() {
  const binDir = getBinDir();
  if (!existsSync(binDir)) try { mkdirSync(binDir, { recursive: true }); } catch {}
  return binDir;
}
