import { join } from "path";

/**
 * One storage subdirectory name, as the environment declares it or its default.
 *
 * @remarks
 * core owns these names (an app declares them in the registry and core's `appPaths` resolves them),
 * but this library carries no core submodule, so the loader that does passes the resolved names down
 * through the environment. Only a single path segment is accepted, matching core: a separator or a
 * traversal would move storage outside the home it belongs to.
 */
export function subdirName(envVar: string, fallback: string): string {
  const declared = (process.env[envVar] || "").trim();
  if (!declared || declared === "." || declared === ".." || /[\\/]/.test(declared)) return fallback;
  return declared;
}

/** Where one home keeps its clones, its deployed bundles, its cache and its config. */
export interface HomePaths {
  /** The home itself. */
  configDir: string;
  /** Where plugin clones live. */
  reposDir: string;
  /** Where deployed bundles and manifest sidecars live. */
  pluginDir: string;
  /** Where derived answers live. */
  cacheDir: string;
  /** Where config files live. */
  configFolder: string;
}

/**
 * The storage directories of an EXPLICIT home.
 *
 * @remarks
 * `env.ts` resolves one home from the environment at import, which is right for the TUI and wrong
 * for the library half: `runEarlyLaunchHooks` is called with the home it must act on. This takes the
 * home as an argument so both halves share one derivation.
 */
export function homePaths(configDir: string): HomePaths {
  return {
    configDir,
    reposDir: join(configDir, subdirName("HUB_REPOS_SUBDIR", "repos")),
    pluginDir: join(configDir, subdirName("HUB_PLUGIN_SUBDIR", "plugin")),
    cacheDir: join(configDir, subdirName("HUB_CACHE_SUBDIR", "cache")),
    configFolder: join(configDir, subdirName("HUB_CONFIG_SUBDIR", "config")),
  };
}
