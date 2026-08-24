import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { readJson } from "./json.js";
import { readDeployedManifests } from "@intisy-ai/api/host";
import { appNpmPlugins, expandPath } from "./app-descriptor.js";
import type { HomePaths } from "./home-paths.js";
import type { CatalogEntry } from "./capability-catalog.js";

// Where the app itself installs an npm plugin, when it has such a mechanism at all.
function npmPackageCache(paths: HomePaths): string {
  const declared = appNpmPlugins();
  return declared?.packageCache ? expandPath(declared.packageCache, paths.configDir) : "";
}

/** The capability a plugin declares to be the one that manages plugins. */
export const PLUGIN_MANAGEMENT_CAPABILITY = "plugin-management";

/** The file this home keeps its derived answer in. */
export const MANAGER_CACHE_FILE = "plugin-manager.json";

/** The plugin that installs and updates plugins in this home. */
export interface PluginManagerRef {
  /** Its manifest id, which is also its deployed bundle basename. */
  id: string;
  /** Its npm package name, for the command an operator runs to install it. */
  npmName: string;
  /** Its clone URL, when a plugin list or a marketplace supplied one. */
  url?: string;
  /** Which resolution step answered, which is what a diagnostic needs to explain itself. */
  source: "deployed" | "clone" | "cache" | "catalog";
}

/** One importable module of the manager, and the package directory its version is read from. */
export interface ManagerEntry {
  /** The module a host imports. */
  entry: string;
  /** The directory holding its `package.json`, or null when the entry has none beside it. */
  packageDir: string | null;
}

/** What resolution reaches the network through. */
export interface ResolveDeps {
  /** Queries the declared marketplace sources. Absent means resolution stays on disk. */
  queryCapability?: (capabilityId: string) => Promise<CatalogEntry[]>;
  /** Diagnostic sink. */
  log?: (message: string) => void;
}

function declaresManagement(manifest: unknown): boolean {
  const capabilities = (manifest as { capabilities?: unknown } | null)?.capabilities;
  return Array.isArray(capabilities) && capabilities.includes(PLUGIN_MANAGEMENT_CAPABILITY);
}

// A clone sits either flat (repos/<name>) or nested under its owner (repos/<owner>/<name>), the same
// two layouts getFolderName already accounts for, so both depths are read.
function cloneDirs(reposDir: string): string[] {
  const dirs: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(reposDir);
  } catch {
    return dirs;
  }
  for (const name of names) {
    const dir = join(reposDir, name);
    if (existsSync(join(dir, "plugin.json"))) {
      dirs.push(dir);
      continue;
    }
    let nested: string[] = [];
    try {
      nested = readdirSync(dir);
    } catch {
      continue;
    }
    for (const child of nested) {
      if (existsSync(join(dir, child, "plugin.json"))) dirs.push(join(dir, child));
    }
  }
  return dirs;
}

/**
 * The clone directory of one plugin id, flat or owner-nested, or null when neither exists.
 *
 * @remarks
 * Which layout a home has depends on how the plugin was installed, so every step that needs a
 * clone's directory asks this instead of assuming `repos/<id>`: assuming it costs a deployed
 * manager its real npm name and its clone's package main.
 */
function cloneDirFor(paths: HomePaths, id: string): string | null {
  const flat = join(paths.reposDir, id);
  if (existsSync(flat)) return flat;
  let owners: string[] = [];
  try {
    owners = readdirSync(paths.reposDir);
  } catch {
    return null;
  }
  for (const owner of owners) {
    const nested = join(paths.reposDir, owner, id);
    if (existsSync(nested)) return nested;
  }
  return null;
}

function packageNameOf(dir: string, fallback: string): string {
  const name = (readJson(join(dir, "package.json")) || {}).name;
  return typeof name === "string" && name ? name : fallback;
}

// The URL a plugin was installed from, which only the home's plugin list knows. Absent is fine: it
// is needed to INSTALL the manager, and a manager already on disk does not need installing.
function urlFor(paths: HomePaths, id: string): string | undefined {
  const listed = readJson(join(paths.configFolder, "plugins.json")) || readJson(join(paths.configDir, "plugins.json"));
  if (!Array.isArray(listed)) return undefined;
  const entry = listed.find((item: { name?: unknown }) => item && item.name === id);
  return entry && typeof entry.url === "string" ? entry.url : undefined;
}

function fromDeployed(paths: HomePaths): PluginManagerRef | null {
  const found = readDeployedManifests(paths.pluginDir).loaded.find((plugin) => declaresManagement(plugin.manifest));
  if (!found) return null;
  const id = found.manifest.id;
  const cloneDir = cloneDirFor(paths, id);
  return { id, npmName: cloneDir ? packageNameOf(cloneDir, id) : id, url: urlFor(paths, id), source: "deployed" };
}

function fromClones(paths: HomePaths): PluginManagerRef | null {
  for (const dir of cloneDirs(paths.reposDir)) {
    const manifest = readJson(join(dir, "plugin.json"));
    if (!declaresManagement(manifest)) continue;
    const declared = (manifest as { id?: unknown }).id;
    const id = typeof declared === "string" && declared ? declared : basename(dir);
    return { id, npmName: packageNameOf(dir, id), url: urlFor(paths, id), source: "clone" };
  }
  return null;
}

/** The answer this home already derived, or null when it never has. */
export function readManagerCache(paths: HomePaths): PluginManagerRef | null {
  const cached = readJson(join(paths.cacheDir, MANAGER_CACHE_FILE));
  const id = (cached as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !id) return null;
  const npmName = (cached as { npmName?: unknown }).npmName;
  const url = (cached as { url?: unknown }).url;
  return {
    id,
    npmName: typeof npmName === "string" && npmName ? npmName : id,
    url: typeof url === "string" ? url : undefined,
    source: "cache",
  };
}

// Written on every fresh answer rather than only the first, so changing marketplace re-derives it.
function writeManagerCache(paths: HomePaths, ref: PluginManagerRef): void {
  try {
    if (!existsSync(paths.cacheDir)) mkdirSync(paths.cacheDir, { recursive: true });
    writeFileSync(
      join(paths.cacheDir, MANAGER_CACHE_FILE),
      JSON.stringify({ id: ref.id, npmName: ref.npmName, url: ref.url }, null, 2),
    );
  } catch {
    // a home that cannot be written to resolves again next launch, which costs a scan, not an answer
  }
}

/**
 * Steps one to three: everything this home can answer without the network.
 *
 * @remarks
 * A deployed manifest first, because that is what the host itself loads; then an installed clone's
 * own manifest, which answers as soon as a plugin's repository declares the capability and before it
 * has ever been deployed; then the answer this home already derived.
 */
export function resolveFromHome(paths: HomePaths): PluginManagerRef | null {
  const found = fromDeployed(paths) ?? fromClones(paths);
  if (found) {
    writeManagerCache(paths, found);
    return found;
  }
  return readManagerCache(paths);
}

/**
 * All four steps: this home, then the marketplaces it declares.
 *
 * @remarks
 * Nothing resolving is not an error. It means no plugin here manages plugins, which is a gate for
 * the operator, and every surface that needs one degrades to reporting that instead of failing.
 */
export async function resolvePluginManager(paths: HomePaths, deps: ResolveDeps = {}): Promise<PluginManagerRef | null> {
  const local = resolveFromHome(paths);
  if (local) return local;
  if (!deps.queryCapability) return null;
  let offered: CatalogEntry[] = [];
  try {
    offered = await deps.queryCapability(PLUGIN_MANAGEMENT_CAPABILITY);
  } catch (error) {
    (deps.log ?? (() => {}))(`marketplace query for a plugin manager failed: ${String(error)}`);
    return null;
  }
  const first = offered[0];
  if (!first) return null;
  const ref: PluginManagerRef = { id: first.id, npmName: first.npmName, url: first.url, source: "catalog" };
  writeManagerCache(paths, ref);
  return ref;
}

/**
 * Every module of the manager this home could import, best first.
 *
 * @remarks
 * The deployed bundle comes first because it is where an ORDINARY plugin lives and it is the artifact
 * the last deploy wrote; the manager is not special. The clone's package main follows, for a plugin
 * cloned but not yet deployed, then the locations an app installs an npm plugin into.
 */
export function managerEntries(paths: HomePaths, ref: PluginManagerRef): ManagerEntry[] {
  const found: ManagerEntry[] = [];
  const cloneDir = cloneDirFor(paths, ref.id);
  const deployed = join(paths.pluginDir, `${ref.id}.js`);
  if (existsSync(deployed)) found.push({ entry: deployed, packageDir: cloneDir });
  const packageDirs = [
    ...(cloneDir ? [cloneDir] : []),
    join(paths.configDir, "node_modules", ref.npmName),
    join(paths.cacheDir, "node_modules", ref.npmName),
    ...(npmPackageCache(paths) ? [join(npmPackageCache(paths), `${ref.npmName}@latest`, "node_modules", ref.npmName)] : []),
  ];
  for (const dir of packageDirs) {
    const main = (readJson(join(dir, "package.json")) || {}).main;
    const entry = join(dir, typeof main === "string" && main ? main : "index.js");
    if (existsSync(entry)) found.push({ entry, packageDir: dir });
  }
  return found;
}

/**
 * The command an operator runs to install the manager.
 *
 * @remarks
 * Returned as TEXT and never executed by this library. `npx` always fetches the published package
 * whatever the home actually has installed, so running it from code would silently replace a git
 * install with an npm one. The operator decides, which is also why the gate shows this string.
 */
export function bootstrapCommand(ref: PluginManagerRef, app: string): string {
  return `npx -y ${ref.npmName}@latest init --app ${app}`;
}
