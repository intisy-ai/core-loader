// @ts-nocheck
// Shared activation helpers for BOTH loaders' plugin.ts (claude-code-loader,
// opencode-loader). Kept core-free — the caller injects its own logger — so
// core-loader stays independent of the core bundle.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
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

// getBinDir() (~/.local/bin) is where the cc/oc wrappers land, but that dir is only
// on PATH by default on some Linux login shells — never on macOS (zsh) or Windows.
// ensureOnPath registers it so `cc`/`oc` actually resolve in new shells. Idempotent
// (marker-guarded on POSIX; membership-checked on Windows) and never throws — a
// failure here just means the user runs the wrapper by full path until they fix PATH.
const PATH_MARKER = "# intisy loader (cc/oc) PATH";

export function ensureOnPath(binDir: string, log: (message: string) => void) {
  try {
    if (process.platform === "win32") ensureOnPathWindows(binDir, log);
    else ensureOnPathPosix(binDir, log);
  } catch (e) {
    log("ensureOnPath failed (wrapper still installed, PATH unchanged): " + e);
  }
}

function ensureOnPathPosix(binDir: string, log: (message: string) => void) {
  const home = homedir();
  // Prefer a $HOME-relative export so a copied dotfile stays correct across machines.
  const exportPath = binDir.startsWith(home)
    ? '$HOME' + binDir.slice(home.length).replace(/\\/g, "/")
    : binDir;
  const block = "\n" + PATH_MARKER + "\nexport PATH=\"" + exportPath + ":$PATH\"\n";

  // ~/.profile is the POSIX login-shell rc (create it so at least one file carries the
  // entry); .bashrc/.zshrc are updated only when they already exist, to match the
  // user's actual shell without inventing config they don't use.
  const always = [join(home, ".profile")];
  const ifPresent = [join(home, ".bashrc"), join(home, ".zshrc")];
  for (const file of [...always, ...ifPresent]) {
    const mustExist = always.includes(file);
    if (!mustExist && !existsSync(file)) continue;
    let current = "";
    try { current = existsSync(file) ? readFileSync(file, "utf-8") : ""; } catch { current = ""; }
    if (current.includes(PATH_MARKER)) continue;
    try {
      writeFileSync(file, current + block, "utf-8");
      log("Registered " + binDir + " on PATH via " + file);
    } catch (e) {
      log("Could not update " + file + ": " + e);
    }
  }
}

function ensureOnPathWindows(binDir: string, log: (message: string) => void) {
  // Read + write the per-user PATH via PowerShell's Environment API (persists to the
  // registry, unlike setx which also truncates >1024 chars). Only new shells see it.
  const ps =
    "$d=" + JSON.stringify(binDir) + ";" +
    "$p=[Environment]::GetEnvironmentVariable('Path','User');" +
    "if($null -eq $p){$p=''};" +
    "$parts=$p.Split(';');" +
    "if($parts -notcontains $d){" +
    "$np=if($p){$d+';'+$p}else{$d};" +
    "[Environment]::SetEnvironmentVariable('Path',$np,'User');" +
    "Write-Output 'added'} else {Write-Output 'present'}";
  const result = execSync(
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "' + ps.replace(/"/g, '\\"') + '"',
    { encoding: "utf-8" },
  ).trim();
  log(result === "added" ? "Registered " + binDir + " on the user PATH" : binDir + " already on PATH");
}
