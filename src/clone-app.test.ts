import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appOfClone } from "./clone-app.js";

let repos: string;
const PRIOR_HUB_APP_ID = process.env.HUB_APP_ID;

beforeEach(() => {
  repos = mkdtempSync(join(tmpdir(), "core-loader-clone-app-"));
});

afterEach(() => {
  rmSync(repos, { recursive: true, force: true });
  process.env.HUB_APP_ID = PRIOR_HUB_APP_ID;
});

// The manifest id is deliberately not the directory name: a clone is found by its directory and
// read by its manifest, and a fixture reusing one string for both would pass either way.
function clone(name: string, declaration?: Record<string, unknown>): void {
  mkdirSync(join(repos, name), { recursive: true });
  if (declaration !== undefined) {
    writeFileSync(join(repos, name, "plugin.json"), JSON.stringify({ id: `${name}-id`, api: 1, ...declaration }), "utf8");
  }
}

describe("appOfClone", () => {
  it("reports the app a clone declares itself the loader for", () => {
    clone("some-loader", { displayName: "Some Loader", app: { id: "claude", label: "Claude Code" } });
    expect(appOfClone(repos, "some-loader")).toBe("claude");
  });

  it("reports null for a clone whose descriptor declares no app", () => {
    clone("a-provider", { displayName: "A Provider", providers: { one: "icon.svg" } });
    expect(appOfClone(repos, "a-provider")).toBeNull();
  });

  it("reports null for a clone with no descriptor at all", () => {
    clone("plain");
    expect(appOfClone(repos, "plain")).toBeNull();
  });

  it("reports null for a clone that is not there", () => {
    expect(appOfClone(repos, "absent")).toBeNull();
  });

  it("reports null for a malformed descriptor rather than throwing", () => {
    mkdirSync(join(repos, "broken"), { recursive: true });
    writeFileSync(join(repos, "broken", "plugin.json"), "{not json", "utf8");
    expect(appOfClone(repos, "broken")).toBeNull();
  });

  it("reports null for an app id that is not a non-empty string", () => {
    clone("odd", { app: { id: 7 } });
    expect(appOfClone(repos, "odd")).toBeNull();
    clone("empty", { app: { id: "" } });
    expect(appOfClone(repos, "empty")).toBeNull();
  });
});

describe("loadPlugins: another app's loader", () => {
  it("keeps every entry whose clone declares this app or no app, and drops the foreign loader", async () => {
    const home = mkdtempSync(join(tmpdir(), "core-loader-load-plugins-"));
    const reposDir = join(home, "repos");
    mkdirSync(join(home, "config"), { recursive: true });
    for (const [name, descriptor] of [
      ["this-loader", { app: { id: "claude" } }],
      ["that-loader", { app: { id: "opencode" } }],
      ["a-provider", { displayName: "A Provider" }],
    ] as Array<[string, unknown]>) {
      mkdirSync(join(reposDir, name), { recursive: true });
      writeFileSync(join(reposDir, name, "plugin.json"), JSON.stringify({ id: `${name}-id`, api: 1, ...(descriptor as object) }), "utf8");
    }
    mkdirSync(join(reposDir, "no-descriptor"), { recursive: true });
    writeFileSync(
      join(home, "config", "plugins.json"),
      JSON.stringify([
        { name: "this-loader" }, { name: "that-loader" }, { name: "a-provider" }, { name: "no-descriptor" }, { name: "never-cloned" },
      ]),
      "utf8",
    );

    process.env.HUB_CONFIG_DIR = home;
    process.env.HUB_APP_ID = "claude";
    vi.resetModules();
    const { loadPlugins } = await import("./config.js");

    expect(loadPlugins().map((entry: { name: string }) => entry.name)).toEqual([
      "this-loader", "a-provider", "no-descriptor", "never-cloned",
    ]);

    process.env.HUB_APP_ID = "";
    vi.resetModules();
    const unfiltered = await import("./config.js");
    expect(unfiltered.loadPlugins().map((entry: { name: string }) => entry.name)).toEqual([
      "this-loader", "that-loader", "a-provider", "no-descriptor", "never-cloned",
    ]);

    rmSync(home, { recursive: true, force: true });
  });
});
