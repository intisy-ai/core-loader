import { pathToFileURL } from "node:url";
import { activationOrder, createPluginHost, isPluginError, PluginError } from "@intisy-ai/api";
import type { Plugin, PluginHost, PluginManifest, PluginRuntime } from "@intisy-ai/api";
import { readDeployedManifests } from "./plugin-manifests.js";
import type { DeployedPlugin, ManifestScan } from "./plugin-manifests.js";

/** How long one plugin's `activate` may take before it is quarantined. */
export const DEFAULT_ACTIVATE_TIMEOUT_MS = 10000;

/** What the host needs from whoever starts it. */
export interface LoaderHostOptions {
  /** The app id plugins see on the host descriptor. */
  app: string;
  /** The home's plugin directory, normally `<home>/plugin`. */
  pluginDir: string;
  /** Surface ids this host renders. */
  surfaces?: string[];
  /** How long one `activate` may take. Defaults to {@link DEFAULT_ACTIVATE_TIMEOUT_MS}. */
  activateTimeoutMs?: number;
  /**
   * Builds the per-plugin runtime.
   *
   * @remarks
   * Injected rather than built here, because this library carries no core submodule: the loader
   * that does passes core's `createPluginRuntime`.
   */
  runtimeFor: (manifest: PluginManifest) => PluginRuntime;
  /** Reads the home. Defaults to {@link readDeployedManifests}, and is replaced in tests. */
  scan?: ManifestScan;
  /** Imports one entry module. Defaults to a dynamic import, and is replaced in tests. */
  importEntry?: (entryPath: string) => Promise<unknown>;
}

/** A running host: what started, what did not, and how to shut it down. */
export interface LoadedHost {
  /** The api package's host, which owns the capabilities, the services and the ledger. */
  host: PluginHost;
  /** Plugin ids that activated cleanly, in activation order. */
  started: string[];
  /** One error per plugin that could not be loaded, each naming the plugin and the fix. */
  quarantined: PluginError[];
  /** Deactivates every started plugin, newest first. */
  stop: () => Promise<void>;
}

function asPlugin(module: unknown): Plugin | null {
  const candidate = (module as { default?: unknown })?.default;
  if (!candidate || typeof candidate !== "object") return null;
  const plugin = candidate as Partial<Plugin>;
  if (typeof plugin.activate !== "function") return null;
  return plugin as Plugin;
}

function errorFor(pluginId: string, error: unknown, fix: string): PluginError {
  if (isPluginError(error)) return error;
  return new PluginError(pluginId, error instanceof Error ? error.message : String(error), fix);
}

async function withTimeout(pluginId: string, timeoutMs: number, run: () => void | Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PluginError(
      pluginId,
      `activate did not finish within ${timeoutMs}ms`,
      "return from activate promptly and do slow work in the background, or raise the host's activate timeout",
    )), timeoutMs);
  });
  try {
    await Promise.race([Promise.resolve().then(run), expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Loads every plugin deployed in a home: manifests first, then dependency order, then one
 * `activate` at a time under its own timeout.
 *
 * @remarks
 * Nothing here branches on a plugin id, and nothing can. Every failure ends as a quarantine naming
 * the plugin and the fix, so one bad plugin costs its own capabilities and nothing else: a cycle
 * quarantines only its members, a throwing `activate` quarantines only its own plugin, and a
 * hanging one is cut loose at the timeout with the host still up.
 */
export async function startPlugins(options: LoaderHostOptions): Promise<LoadedHost> {
  const timeoutMs = options.activateTimeoutMs ?? DEFAULT_ACTIVATE_TIMEOUT_MS;
  const importEntry = options.importEntry ?? (async (entryPath: string) => import(pathToFileURL(entryPath).href));
  const scan = options.scan ?? readDeployedManifests(options.pluginDir);

  const host = createPluginHost({ app: options.app, surfaces: options.surfaces ?? [] });
  const quarantined: PluginError[] = [...scan.failed];
  const started: string[] = [];
  const plugins = new Map<string, Plugin>();
  const byId = new Map<string, DeployedPlugin>(scan.loaded.map((plugin) => [plugin.manifest.id, plugin]));

  const plan = activationOrder(scan.loaded.map((plugin) => plugin.manifest));
  for (const cycle of plan.cycles) {
    for (const pluginId of cycle) {
      const error = new PluginError(
        pluginId,
        `is in a dependency cycle: ${cycle.join(" -> ")} -> ${cycle[0]}`,
        "break the cycle by removing one plugin's entry from services.consumes in its plugin.json",
      );
      host.markBroken(pluginId, error);
      quarantined.push(error);
    }
  }

  for (const pluginId of plan.order) {
    const deployed = byId.get(pluginId);
    if (!deployed) continue;
    const { manifest, entryPath } = deployed;

    const unsupported = host.supports(manifest);
    if (unsupported) {
      host.markBroken(pluginId, unsupported);
      quarantined.push(unsupported);
      continue;
    }

    if (!entryPath) {
      const error = new PluginError(
        pluginId,
        manifest.entry ? "declares an entry but no bundle is deployed beside its manifest" : "declares no entry, so there is nothing to activate",
        manifest.entry ? "deploy the plugin again so its bundle lands beside the sidecar" : "add \"entry\": \"dist/index.js\" to plugin.json if this plugin has capabilities",
      );
      host.markBroken(pluginId, error);
      quarantined.push(error);
      continue;
    }

    let plugin: Plugin | null;
    try {
      plugin = asPlugin(await importEntry(entryPath));
    } catch (error) {
      const failure = errorFor(pluginId, error, "rebuild the plugin: its deployed bundle could not be imported");
      host.markBroken(pluginId, failure);
      quarantined.push(failure);
      continue;
    }

    if (!plugin) {
      const error = new PluginError(
        pluginId,
        "its entry module exports no plugin",
        "export default a class implementing Plugin, or definePlugin({ activate, deactivate })",
      );
      host.markBroken(pluginId, error);
      quarantined.push(error);
      continue;
    }

    const context = host.contextFor(manifest, options.runtimeFor(manifest));
    try {
      await withTimeout(pluginId, timeoutMs, () => plugin.activate(context));
    } catch (error) {
      const failure = errorFor(pluginId, error, "fix the error activate threw, or disable the plugin");
      host.markBroken(pluginId, failure);
      quarantined.push(failure);
      continue;
    }

    const mismatch = host.verifyActivation(manifest);
    if (mismatch) {
      host.markBroken(pluginId, mismatch);
      quarantined.push(mismatch);
      continue;
    }

    plugins.set(pluginId, plugin);
    started.push(pluginId);
  }

  return {
    host,
    started,
    quarantined,
    stop: async () => {
      for (const pluginId of [...started].reverse()) {
        const plugin = plugins.get(pluginId);
        if (!plugin) continue;
        try {
          await plugin.deactivate();
        } catch (error) {
          host.markBroken(pluginId, errorFor(pluginId, error, "fix the error deactivate threw; the plugin was stopped anyway"));
          continue;
        }
        host.release(pluginId);
      }
    },
  };
}
