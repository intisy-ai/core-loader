import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { homePaths } from "./home-paths.js";

// Pinned at a path no registry occupies, so these assertions never depend on the apps.json of
// whoever runs them.
beforeEach(() => { process.env.HUB_APPS_FILE = join("/nonexistent", "apps.json"); });
afterEach(() => { delete process.env.HUB_APPS_FILE; delete process.env.HUB_REPOS_SUBDIR; });

describe("homePaths", () => {
  it("resolves the four directories under the home it was given, not the environment's", () => {
    const paths = homePaths("/homes/demo");
    expect(paths.configDir).toBe("/homes/demo");
    expect(paths.reposDir).toBe(join("/homes/demo", "repos"));
    expect(paths.pluginDir).toBe(join("/homes/demo", "plugin"));
    expect(paths.cacheDir).toBe(join("/homes/demo", "cache"));
    expect(paths.configFolder).toBe(join("/homes/demo", "config"));
  });

  it("honors a declared subdirectory name", () => {
    process.env.HUB_REPOS_SUBDIR = "clones";
    expect(homePaths("/homes/demo").reposDir).toBe(join("/homes/demo", "clones"));
  });

  // These name a directory INSIDE the home, so a separator or a traversal would relocate storage
  // outside it. The rule is core's; this holds that core-loader still reaches it.
  it("falls back for an empty, traversing or nested name", () => {
    for (const bad of ["   ", "..", ".", "a/b", "a\\b"]) {
      process.env.HUB_REPOS_SUBDIR = bad;
      expect(homePaths("/homes/demo").reposDir).toBe(join("/homes/demo", "repos"));
    }
  });
});
