import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { assertManifest, isPluginError, PluginError } from "@intisy-ai/api";
import type { PluginManifest } from "@intisy-ai/api";

/** One plugin as it sits deployed in a home: its manifest sidecar and the bundle beside it. */
export interface DeployedPlugin {
  /** The validated manifest. */
  manifest: PluginManifest;
  /** Absolute path of the sidecar this was read from. */
  manifestPath: string;
  /** Absolute path of the deployed bundle, or null when the plugin declares no entry or none is deployed. */
  entryPath: string | null;
}

/** What one scan of a home's plugin directory found, and what it could not read. */
export interface ManifestScan {
  /** Every plugin whose manifest validated, ordered by id. */
  loaded: DeployedPlugin[];
  /** One error per sidecar that could not be read or did not validate. */
  failed: PluginError[];
}

function entryFor(pluginDir: string, manifest: PluginManifest): string | null {
  if (!manifest.entry) return null;
  const deployed = join(pluginDir, `${manifest.id}.js`);
  return existsSync(deployed) ? deployed : null;
}

/**
 * Reads every manifest sidecar deployed in a home.
 *
 * @remarks
 * Deploy writes the manifest beside the bundle, so identity and capability questions are answered
 * from disk without importing anything. One unreadable sidecar becomes one entry in `failed` and
 * never discards the rest of the home, because a host that hides every plugin behind one bad file
 * is a host nobody can diagnose.
 *
 * @param pluginDir - the home's plugin directory, normally `<home>/plugin`
 */
export function readDeployedManifests(pluginDir: string): ManifestScan {
  const loaded: DeployedPlugin[] = [];
  const failed: PluginError[] = [];

  let names: string[];
  try {
    names = readdirSync(pluginDir);
  } catch {
    return { loaded, failed };
  }

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const manifestPath = join(pluginDir, name);
    const id = basename(name, ".json");
    try {
      const manifest = assertManifest(JSON.parse(readFileSync(manifestPath, "utf-8")));
      loaded.push({ manifest, manifestPath, entryPath: entryFor(pluginDir, manifest) });
    } catch (error) {
      failed.push(isPluginError(error)
        ? error
        : new PluginError(id, `${manifestPath} is not readable as JSON: ${String(error)}`, "redeploy the plugin so its plugin.json sidecar is written again"));
    }
  }

  loaded.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  return { loaded, failed };
}
