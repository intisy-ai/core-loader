import { join } from "path";

/**
 * Every loader resolves its config dir the same way: HUB_CONFIG_DIR overrides
 * the app's own default home. Each loader supplies its own default (the only
 * app-specific piece) and gets the resolution logic from here.
 */
export function loaderConfigDir(appHomeDefault: string): string {
  return process.env.HUB_CONFIG_DIR || appHomeDefault;
}

/** Where this home keeps its clones, honouring an override the environment set. */
export function loaderReposDir(appHomeDefault: string): string {
  return join(loaderConfigDir(appHomeDefault), "repos");
}
