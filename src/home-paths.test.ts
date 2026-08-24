import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { homePaths, subdirName } from "./home-paths.js";

const VAR = "HUB_TEST_SUBDIR";

afterEach(() => { delete process.env[VAR]; delete process.env.HUB_REPOS_SUBDIR; });

describe("subdirName", () => {
  it("answers the declared name when it is a single path segment", () => {
    process.env[VAR] = "clones";
    expect(subdirName(VAR, "repos")).toBe("clones");
  });

  it("falls back for an undeclared, empty, traversing or nested name", () => {
    expect(subdirName(VAR, "repos")).toBe("repos");
    process.env[VAR] = "   ";
    expect(subdirName(VAR, "repos")).toBe("repos");
    process.env[VAR] = "..";
    expect(subdirName(VAR, "repos")).toBe("repos");
    process.env[VAR] = "a/b";
    expect(subdirName(VAR, "repos")).toBe("repos");
    process.env[VAR] = "a\\b";
    expect(subdirName(VAR, "repos")).toBe("repos");
  });
});

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
});
