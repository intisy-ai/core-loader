import { existsSync, readdirSync, statSync } from "fs";
import { isAbsolute, join } from "path";
import { homedir } from "os";
import { readJson } from "./json.js";
import { subdirName } from "./home-paths.js";

/** The npm-plugin mechanism an app declares, or nothing when it has none. */
export interface NpmPluginsTrait {
  configFiles: string[];
  pluginsKey: string;
  packageCache?: string;
}

/** Where a marketplace looks for this app's community plugins. */
export interface DiscoveryTrait {
  topic?: string;
  searchQuery?: string;
  awesomeList?: string;
}

/** Where this app records the projects a user has worked in. */
export interface ProjectsTrait {
  historyFile?: string;
  sessionDb?: string[];
  /** The file this app writes inside a project's `.git` directory to record the project id. */
  markerFile?: string;
}

/**
 * One app, as its own project declares it.
 *
 * @remarks
 * Structurally mirrored from core's `AppDescriptor` rather than imported: this library carries no
 * `core` submodule, the same reason `home-paths.ts` mirrors the storage subdirectory names.
 */
export interface AppDescriptor {
  id: string;
  label?: string;
  home: { envOverride?: string; nativeEnv?: string; xdgSubdir?: string; candidates: string[] };
  detect?: { binary?: string; pkg?: string };
  loader?: { id: string; url: string };
  accent?: string;
  /** The command a user types to launch this app through the loader's wrapper. Absent means
   *  the app is launched by its own binary. */
  wrapperCommand?: string;
  npmPlugins?: NpmPluginsTrait;
  discovery?: DiscoveryTrait;
  projects?: ProjectsTrait;
}

function trimmed(value?: string): string {
  return value && value.trim() ? value.trim() : "";
}

function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

/** One declared path, resolved: `~` is the user home, a bare name is inside the app home. */
export function expandPath(value: string, appHome: string): string {
  const raw = trimmed(value);
  if (!raw) return "";
  if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) return expandTilde(raw);
  return isAbsolute(raw) ? raw : join(appHome, raw);
}

function registryFile(): string {
  return trimmed(process.env.HUB_APPS_FILE) || join(homedir(), ".config", "cairn", "apps.json");
}

let REGISTRY: AppDescriptor[] | null = null;
let REGISTRY_KEY = "";

function registry(): AppDescriptor[] {
  const file = registryFile();
  let mtime = 0;
  try { mtime = existsSync(file) ? statSync(file).mtimeMs : 0; } catch { mtime = 0; }
  const key = file + "::" + mtime;
  if (REGISTRY && REGISTRY_KEY === key) return REGISTRY;
  const parsed = readJson(file, {}) as Record<string, Partial<AppDescriptor>>;
  const out: AppDescriptor[] = [];
  for (const [id, entry] of Object.entries(parsed || {})) {
    const desc = { ...entry, id: entry?.id ?? id } as AppDescriptor;
    if (!desc.id || !desc.home || !Array.isArray(desc.home.candidates)) continue;
    out.push(desc);
  }
  REGISTRY = out;
  REGISTRY_KEY = key;
  return out;
}

/** Every app the registry declares. */
export function appDescriptors(): AppDescriptor[] {
  return registry();
}

/** One app by id, from the registry alone. Needs no home, so `env.ts` can call it at import. */
export function registryDescriptor(appId: string): AppDescriptor | null {
  if (!appId) return null;
  return registry().find((desc) => desc.id === appId) || null;
}

/** The home directory an app declares. */
export function resolveHome(desc: AppDescriptor): string {
  if (!desc.home) return "";
  const over = desc.home.envOverride ? trimmed(process.env[desc.home.envOverride]) : "";
  if (over) return over;
  const native = desc.home.nativeEnv ? trimmed(process.env[desc.home.nativeEnv]) : "";
  if (native) return native;
  if (desc.home.xdgSubdir) {
    const xdg = trimmed(process.env.XDG_CONFIG_HOME);
    if (xdg) return join(xdg, desc.home.xdgSubdir);
  }
  const candidates = desc.home.candidates.map(expandTilde);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return candidates[candidates.length - 1] ?? "";
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Which app this process runs under when nothing injected an id.
 *
 * @remarks
 * Detection matches against what each app DECLARES about itself, never a name this library holds.
 * An empty answer is honest: an uninjected, undetected app is unknown, not a default one.
 */
export function detectAppId(): string {
  const apps = registry();
  const argv = process.argv.join(" ").toLowerCase().split(/[^a-z0-9]+/);
  const byArgv = apps.find((desc) => desc.detect?.binary && argv.includes(desc.detect.binary.toLowerCase()));
  if (byArgv) return byArgv.id;
  const byEnv = apps.find((desc) => desc.home.nativeEnv && trimmed(process.env[desc.home.nativeEnv]));
  if (byEnv) return byEnv.id;
  const forced = trimmed(process.env.HUB_CONFIG_DIR);
  if (forced) {
    const target = normalize(forced);
    const byDir = apps.find((desc) => desc.home.candidates
      .map((candidate) => normalize(expandTilde(candidate)))
      .some((candidate) => candidate && (target === candidate || target.startsWith(candidate + "/"))));
    if (byDir) return byDir.id;
  }
  return "";
}

function activeId(): string {
  return trimmed(process.env.HUB_APP_ID) || detectAppId();
}

// The clone's own cairn.json is the app project's declaration and is therefore fresher than the
// registry, which a dashboard rewrites only when it runs. Cached per process: a home gains or
// loses a clone between launches, not during one.
let ACTIVE: AppDescriptor | null | undefined;

function cloneAppBlocks(): { loaderId: string; app: AppDescriptor }[] {
  const home = trimmed(process.env.HUB_CONFIG_DIR);
  const base = home || (registryDescriptor(activeId()) ? resolveHome(registryDescriptor(activeId())!) : "");
  if (!base) return [];
  const reposDir = join(base, subdirName("HUB_REPOS_SUBDIR", "repos"));
  let names: string[] = [];
  try { names = readdirSync(reposDir); } catch { return []; }
  const found: { loaderId: string; app: AppDescriptor }[] = [];
  for (const name of names) {
    const manifest = readJson(join(reposDir, name, "cairn.json")) as { app?: AppDescriptor } | null;
    const app = manifest?.app;
    if (app && typeof app.id === "string" && app.id) found.push({ loaderId: name, app });
  }
  return found;
}

/** The descriptor of the app this home belongs to, or null when it is unknown. */
export function activeDescriptor(): AppDescriptor | null {
  if (ACTIVE !== undefined) return ACTIVE;
  const id = activeId();
  const fromRegistry = registryDescriptor(id);
  const declared = cloneAppBlocks().find((entry) => (id ? entry.app.id === id : true));
  ACTIVE = declared
    ? { ...(fromRegistry || {}), ...declared.app }
    : fromRegistry;
  return ACTIVE;
}

/**
 * The id of the loader this home's own app is loaded by.
 *
 * @remarks
 * A home holds exactly one clone whose `cairn.json` declares an app, and that clone IS this app's
 * loader, so the answer needs no injected value and no name. The registry's declared loader is the
 * fallback for a home whose loader is deployed without a clone beside it.
 */
export function loaderIdOfHome(): string {
  const id = activeId();
  const declared = cloneAppBlocks().find((entry) => (id ? entry.app.id === id : true));
  if (declared) return declared.app.loader?.id || declared.loaderId;
  return activeDescriptor()?.loader?.id || "";
}

/** The app's accent colour as `#rrggbb`, or "" when it declares none. */
export function appAccent(): string {
  return trimmed(activeDescriptor()?.accent);
}

/**
 * The command a user types to launch this app, as the app declares it, or "" when undeclared.
 *
 * @remarks
 * Falling back to `CLI_CMD` here would import env.ts, which already imports this module: the
 * caller applies that fallback instead.
 */
export function appWrapperCommand(): string {
  return trimmed(activeDescriptor()?.wrapperCommand);
}

/** The app's npm-plugin mechanism, or null when it has none. */
export function appNpmPlugins(): NpmPluginsTrait | null {
  const declared = activeDescriptor()?.npmPlugins;
  return declared && Array.isArray(declared.configFiles) && declared.pluginsKey ? declared : null;
}

/** Where a marketplace looks for this app's community plugins. */
export function appDiscovery(): DiscoveryTrait {
  return activeDescriptor()?.discovery || {};
}

/** Where this app records the projects a user has worked in. */
export function appProjects(): ProjectsTrait {
  return activeDescriptor()?.projects || {};
}
