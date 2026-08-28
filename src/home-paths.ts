import { appIdForHome, appPaths, getAppDescriptor } from "@intisy-ai/core";

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
 *
 * The names come from the app that OWNS this home rather than from the process environment, so
 * driving another app's home resolves that app's declared names.
 */
export function homePaths(configDir: string): HomePaths {
  const paths = appPaths(configDir, getAppDescriptor(appIdForHome(configDir)) ?? null);
  return {
    configDir,
    reposDir: paths.repos,
    pluginDir: paths.plugin,
    cacheDir: paths.cache,
    configFolder: paths.config,
  };
}
