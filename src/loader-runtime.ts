// Shared activation helpers for BOTH loaders' plugin.ts (claude-code-loader,
// opencode-loader). Kept core-free (the caller injects its own logger) so
// core-loader stays independent of the core bundle.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { readJson } from "./json.js";
import { execSync } from "child_process";
import { dirname, join } from "path";
import { homedir } from "os";
import { pathToFileURL } from "url";
import { homePaths } from "./home-paths.js";
import { managerEntries, resolveFromHome, PLUGIN_MANAGEMENT_CAPABILITY } from "./plugin-manager.js";
import type { PluginManagerModule } from "./plugin-manager.js";
import { PROVIDER_MANIFEST_KEY } from "./catalogs.js";

/** One provider handler this home can route to. */
export interface DeployedProvider {
  /** The provider's name, which is what the router matches. */
  provider: string;
  /** The clone that declared it. */
  repo: string;
  /** The handler file, relative to that clone. */
  handler: string;
  /** That file's absolute path. */
  handlerPath: string;
  /** The wire-format translator it needs, when it names one. */
  translator: string | undefined;
  /** The account pool it draws from, which defaults to its own name. */
  accountPool: string;
  /** The models it advertises. */
  models: unknown[];
}

/** One provider exactly as a plugin's `package.json` declares it. */
interface DeclaredProvider {
  /** Its name, which defaults to the clone's. */
  name?: string;
  /** The handler file, relative to the clone. */
  handler?: string;
  /** The wire-format translator it needs. */
  translator?: string;
  /** The account pool it draws from. */
  accountPool?: string;
  /** The models it advertises. */
  models?: unknown[];
  /** The clone it belongs to, for a lane a plugin materialised rather than declared. */
  repo?: string;
}

/** The part of a plugin's `package.json` this scan reads. */
type ProviderManifest = Record<string, unknown> & {
  /** Providers declared at the top level, which predates the manifest key. */
  authProviders?: DeclaredProvider[];
};

/** Where the loader's shell wrappers are installed. */
export function getBinDir() {
  return join(homedir(), ".local", "bin");
}

/**
 * Resolve the plugin that manages plugins in THIS home, then import it. Disk only: this runs inside
 * an app's plugin activation under a hook timeout, where reading a marketplace over the network is
 * the wrong thing to do.
 */
export async function loadUpdater(configDir: string): Promise<PluginManagerModule> {
  const paths = homePaths(configDir);
  const ref = resolveFromHome(paths);
  if (!ref) throw new Error("no plugin in this home declares the " + PLUGIN_MANAGEMENT_CAPABILITY + " capability");
  const failures: string[] = [];
  for (const candidate of managerEntries(paths, ref)) {
    try {
      return (await import(pathToFileURL(candidate.entry).href)) as PluginManagerModule;
    } catch (e) {
      failures.push(candidate.entry + ": " + e);
    }
  }
  throw new Error(ref.id + " declares " + PLUGIN_MANAGEMENT_CAPABILITY + " but no module of it could be imported" + (failures.length ? " (" + failures.join("; ") + ")" : ""));
}

/**
 * Run the plugin manager's earlyLaunch on activation. `log(message)` is the caller's
 * per-plugin logger; skipped when we're already inside a plugin manager run.
 */
export async function runEarlyLaunchHooks(configDir: string, log: (message: string) => void) {
  if (process.env.INTISY_PLUGIN_ACTIVATION === "1" || process.env.PLUGIN_UPDATER_ACTIVATION === "1") {
    log("Updates driven by the plugin manager (activation context), skipping earlyLaunch");
    return;
  }
  try {
    const updater = await loadUpdater(configDir);
    if (!updater.getPlugins || !updater.earlyLaunch) {
      log("the plugin manager in this home runs no earlyLaunch, skipping updates");
      return;
    }
    const gitPlugins = updater.getPlugins(configDir);
    log("Running earlyLaunch for " + gitPlugins.length + " plugins");
    await updater.earlyLaunch(configDir, gitPlugins);
    log("earlyLaunch complete");
  } catch (e) {
    log("no plugin manager available, skipping updates: " + e);
  }
}

/**
 * Provider handlers deployed under <configDir>/repos: each plugin declares them in its
 * package.json via its PROVIDER_MANIFEST_KEY (or a top-level `authProviders`), plus the lanes a
 * plugin materializes into this home (see homeDynamicProviders). One scan shared by the loader
 * CLI's provider/doctor views and the CC proxy's request router.
 */
export function readDeployedProviders(reposDir: string, configDir: string = dirname(reposDir)): DeployedProvider[] {
  const out: DeployedProvider[] = [];
  let repos: string[] = [];
  try { repos = readdirSync(reposDir); } catch { /* no repos dir */ }
  for (const repo of repos) {
    const pkg = readJson<ProviderManifest>(join(reposDir, repo, "package.json"));
    if (!pkg) continue;
    const keyed = pkg[PROVIDER_MANIFEST_KEY] as { authProviders?: DeclaredProvider[] } | undefined;
    const declared: DeclaredProvider[] = (keyed && keyed.authProviders) || pkg.authProviders || [];
    for (const provider of declared) {
      if (!provider.handler) continue;
      const name = provider.name || repo;
      out.push({
        provider: name,
        repo,
        handler: provider.handler,
        handlerPath: join(reposDir, repo, provider.handler),
        translator: provider.translator,
        accountPool: provider.accountPool || name,
        models: provider.models || [],
      });
    }
  }
  out.push(...homeDynamicProviders(reposDir, configDir));
  return out;
}

// The lanes a plugin materialized into THIS home, one per user-configured endpoint. Best-effort and
// synchronous like the rest of this scan: an absent or malformed file yields no entries. Keyed by
// deployed plugin id, and every key is read; nothing here names a plugin.
function homeDynamicProviders(reposDir: string, configDir: string): DeployedProvider[] {
  const out: DeployedProvider[] = [];
  const declared = readJson<Record<string, DeclaredProvider[]>>(join(homePaths(configDir).cacheDir, "dynamic-providers.json"));
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) return out;
  for (const pluginId of Object.keys(declared)) {
    const lanes = declared[pluginId];
    if (!Array.isArray(lanes)) continue;
    for (const lane of lanes) {
      if (!lane || typeof lane.name !== "string" || typeof lane.handler !== "string") continue;
      const repo = typeof lane.repo === "string" && lane.repo ? lane.repo : pluginId;
      out.push({
        provider: lane.name,
        repo,
        handler: lane.handler,
        handlerPath: join(reposDir, repo, lane.handler),
        translator: lane.translator,
        accountPool: lane.accountPool || lane.name,
        models: lane.models || [],
      });
    }
  }
  return out;
}

// getBinDir() (~/.local/bin) is where the cc/oc wrappers land, but that dir is only
// on PATH by default on some Linux login shells, never on macOS (zsh) or Windows.
// ensureOnPath registers it so `cc`/`oc` actually resolve in new shells. Idempotent
// (marker-guarded on POSIX; membership-checked on Windows) and never throws: a
// failure here just means the user runs the wrapper by full path until they fix PATH.
const PATH_MARKER = "# intisy loader (cc/oc) PATH";

/** Registers that directory on PATH for new shells, idempotently, and never throws. */
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
