import { readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  appIdForHome,
  appPaths,
  expandPath as coreExpandPath,
  currentAppId,
  getAppDescriptor,
  getApps,
  readCloneManifest,
  resolveHome as coreResolveHome,
} from "@intisy-ai/core";
import type { AppDescriptor } from "@intisy-ai/core";

export type { AppDescriptor };

/** The npm-plugin mechanism an app declares, or nothing when it has none. */
export type NpmPluginsTrait = NonNullable<AppDescriptor["npmPlugins"]>;

/** Where a marketplace looks for this app's community plugins. */
export type DiscoveryTrait = NonNullable<AppDescriptor["discovery"]>;

/** Where this app records the projects a user has worked in. */
export type ProjectsTrait = NonNullable<AppDescriptor["projects"]>;

function trimmed(value?: string): string {
  return value && value.trim() ? value.trim() : "";
}

/** One declared path, resolved: `~` is the user home, a bare name is inside the app home. */
export function expandPath(value: string, appHome: string): string {
  return coreExpandPath(value, homedir(), appHome);
}

/** Every app the registry declares. */
export function appDescriptors(): AppDescriptor[] {
  return getApps();
}

/** One app by id, from the registry alone. Needs no home, so `env.ts` can call it at import. */
export function registryDescriptor(appId: string): AppDescriptor | null {
  return appId ? getAppDescriptor(appId) ?? null : null;
}

/** The home directory an app declares. */
export function resolveHome(desc: AppDescriptor): string {
  return coreResolveHome(desc);
}

/**
 * Which app this process runs under when nothing injected an id.
 *
 * @implNote the injected id wins over detection here, and `CORE_APP` is stripped so it cannot
 * outrank `HUB_APP_ID`, which `env.ts` has always read first.
 */
export function detectAppId(): string {
  const { CORE_APP: _injected, ...detected } = process.env;
  return currentAppId(detected);
}

function activeId(): string {
  return trimmed(process.env.CORE_APP) || trimmed(process.env.HUB_APP_ID) || detectAppId();
}

// The clone's own manifest is the app project's declaration and is therefore fresher than the
// registry, which a dashboard rewrites only when it runs. Cached per process: a home gains or
// loses a clone between launches, not during one.
let ACTIVE: AppDescriptor | null | undefined;

function cloneAppBlocks(): { loaderId: string; app: AppDescriptor }[] {
  const forced = trimmed(process.env.HUB_CONFIG_DIR);
  const declared = registryDescriptor(activeId());
  const base = forced || (declared ? resolveHome(declared) : "");
  if (!base) return [];
  const reposDir = appPaths(base, declared ?? getAppDescriptor(appIdForHome(base)) ?? null).repos;
  let names: string[] = [];
  try { names = readdirSync(reposDir); } catch { return []; }
  const found: { loaderId: string; app: AppDescriptor }[] = [];
  for (const name of names) {
    const app = readCloneManifest(join(reposDir, name))?.app;
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
 * A home holds exactly one clone whose manifest declares an app, and that clone IS this app's
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
