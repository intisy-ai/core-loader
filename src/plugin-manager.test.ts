import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homePaths } from "./home-paths.js";
import type { HomePaths } from "./home-paths.js";
import type { CatalogEntry } from "./capability-catalog.js";
import {
  MANAGER_CACHE_FILE,
  PLUGIN_MANAGEMENT_CAPABILITY,
  bootstrapCommand,
  managerEntries,
  readManagerCache,
  resolveFromHome,
  resolvePluginManager,
} from "./plugin-manager.js";

function tempPaths(): HomePaths {
  const paths = homePaths(mkdtempSync(join(tmpdir(), "core-loader-manager-")));
  for (const dir of [paths.reposDir, paths.pluginDir, paths.cacheDir, paths.configFolder]) mkdirSync(dir, { recursive: true });
  return paths;
}

function writeSidecar(paths: HomePaths, id: string, capabilities: string[]): void {
  writeFileSync(join(paths.pluginDir, `${id}.json`), JSON.stringify({ id, api: 1, entry: "dist/index.js", capabilities }));
  writeFileSync(join(paths.pluginDir, `${id}.js`), "export function updatePluginPublic() {}\n");
}

function writeClone(paths: HomePaths, folder: string, manifest: unknown, pkg: unknown): string {
  const dir = join(paths.reposDir, folder);
  mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
  if (pkg !== undefined) writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
}

describe("resolveFromHome", () => {
  it("answers the deployed plugin whose manifest declares the capability", () => {
    const paths = tempPaths();
    writeSidecar(paths, "other-plugin", ["screens"]);
    writeSidecar(paths, "demo-manager", ["settings", PLUGIN_MANAGEMENT_CAPABILITY]);
    writeClone(paths, "demo-manager", undefined, { name: "@demo/manager", main: "dist/index.js" });
    writeFileSync(join(paths.configFolder, "plugins.json"), JSON.stringify([{ name: "demo-manager", url: "https://github.com/demo/manager.git" }]));

    const ref = resolveFromHome(paths);
    expect(ref).toEqual({
      id: "demo-manager",
      npmName: "@demo/manager",
      url: "https://github.com/demo/manager.git",
      source: "deployed",
    });
  });

  it("reads a deployed manager's npm name from an owner-nested clone", () => {
    const paths = tempPaths();
    writeSidecar(paths, "demo-manager", [PLUGIN_MANAGEMENT_CAPABILITY]);
    writeClone(paths, join("some-owner", "demo-manager"), undefined, { name: "@demo/manager" });
    expect(resolveFromHome(paths)?.npmName).toBe("@demo/manager");
  });

  it("answers an installed clone's own manifest when nothing is deployed, flat or owner-nested", () => {
    const flat = tempPaths();
    writeClone(flat, "flat-manager", { id: "flat-manager", api: 1, capabilities: [PLUGIN_MANAGEMENT_CAPABILITY] }, { name: "flat-manager" });
    expect(resolveFromHome(flat)?.source).toBe("clone");
    expect(resolveFromHome(flat)?.id).toBe("flat-manager");

    const nested = tempPaths();
    writeClone(nested, join("some-owner", "nested-manager"), { id: "nested-manager", api: 1, capabilities: [PLUGIN_MANAGEMENT_CAPABILITY] }, { name: "nested-manager" });
    expect(resolveFromHome(nested)?.id).toBe("nested-manager");
  });

  it("writes the derived answer into the home's cache", () => {
    const paths = tempPaths();
    writeSidecar(paths, "demo-manager", [PLUGIN_MANAGEMENT_CAPABILITY]);
    resolveFromHome(paths);
    const cached = JSON.parse(readFileSync(join(paths.cacheDir, MANAGER_CACHE_FILE), "utf8"));
    expect(cached.id).toBe("demo-manager");
    expect(readManagerCache(paths)).toEqual({ id: "demo-manager", npmName: "demo-manager", url: undefined, source: "cache" });
  });

  it("falls back to the cached answer, and answers null for a home that has never derived one", () => {
    const paths = tempPaths();
    expect(resolveFromHome(paths)).toBeNull();
    writeFileSync(join(paths.cacheDir, MANAGER_CACHE_FILE), JSON.stringify({ id: "cached-manager", npmName: "@demo/cached" }));
    expect(resolveFromHome(paths)).toEqual({ id: "cached-manager", npmName: "@demo/cached", url: undefined, source: "cache" });
  });

  it("ignores a plugin that declares other capabilities and one whose sidecar is unreadable", () => {
    const paths = tempPaths();
    writeSidecar(paths, "screens-only", ["screens"]);
    writeFileSync(join(paths.pluginDir, "broken.json"), "{ not json");
    expect(resolveFromHome(paths)).toBeNull();
  });
});

describe("resolvePluginManager", () => {
  it("prefers the home over the marketplace, and never queries when the home answered", async () => {
    const paths = tempPaths();
    writeSidecar(paths, "demo-manager", [PLUGIN_MANAGEMENT_CAPABILITY]);
    let queried = 0;
    const ref = await resolvePluginManager(paths, {
      queryCapability: async () => { queried++; return []; },
    });
    expect(ref?.source).toBe("deployed");
    expect(queried).toBe(0);
  });

  it("takes the first entry a declared marketplace offers, and caches it", async () => {
    const paths = tempPaths();
    const offered: CatalogEntry[] = [
      { id: "offered-manager", npmName: "@demo/offered", url: "https://github.com/demo/offered.git", capabilities: [PLUGIN_MANAGEMENT_CAPABILITY], description: "", sourceId: "s" },
      { id: "second", npmName: "second", url: "u", capabilities: [PLUGIN_MANAGEMENT_CAPABILITY], description: "", sourceId: "s" },
    ];
    const ref = await resolvePluginManager(paths, { queryCapability: async () => offered });
    expect(ref).toEqual({ id: "offered-manager", npmName: "@demo/offered", url: "https://github.com/demo/offered.git", source: "catalog" });
    expect(existsSync(join(paths.cacheDir, MANAGER_CACHE_FILE))).toBe(true);
  });

  it("answers null with no query available, when nothing is offered, and when the query throws", async () => {
    const paths = tempPaths();
    expect(await resolvePluginManager(paths)).toBeNull();
    expect(await resolvePluginManager(paths, { queryCapability: async () => [] })).toBeNull();
    const logged: string[] = [];
    expect(await resolvePluginManager(paths, {
      queryCapability: async () => { throw new Error("offline"); },
      log: (message) => logged.push(message),
    })).toBeNull();
    expect(logged.some((line) => line.includes("offline"))).toBe(true);
  });
});

describe("managerEntries", () => {
  it("offers the deployed bundle first, then the clone's package main", () => {
    const paths = tempPaths();
    writeSidecar(paths, "demo-manager", [PLUGIN_MANAGEMENT_CAPABILITY]);
    const cloneDir = writeClone(paths, "demo-manager", undefined, { name: "demo-manager", main: "dist/index.js" });
    mkdirSync(join(cloneDir, "dist"), { recursive: true });
    writeFileSync(join(cloneDir, "dist", "index.js"), "export function updatePluginPublic() {}\n");

    const found = managerEntries(paths, { id: "demo-manager", npmName: "demo-manager", source: "deployed" });
    expect(found[0]).toEqual({ entry: join(paths.pluginDir, "demo-manager.js"), packageDir: cloneDir });
    expect(found[1]).toEqual({ entry: join(cloneDir, "dist", "index.js"), packageDir: cloneDir });
  });

  it("offers an owner-nested clone's package main and reports it as the package directory", () => {
    const paths = tempPaths();
    writeSidecar(paths, "demo-manager", [PLUGIN_MANAGEMENT_CAPABILITY]);
    const cloneDir = writeClone(paths, join("some-owner", "demo-manager"), undefined, { name: "@demo/manager", main: "dist/index.js" });
    mkdirSync(join(cloneDir, "dist"), { recursive: true });
    writeFileSync(join(cloneDir, "dist", "index.js"), "export function updatePluginPublic() {}\n");

    const found = managerEntries(paths, { id: "demo-manager", npmName: "@demo/manager", source: "deployed" });
    expect(found[0]).toEqual({ entry: join(paths.pluginDir, "demo-manager.js"), packageDir: cloneDir });
    expect(found[1]).toEqual({ entry: join(cloneDir, "dist", "index.js"), packageDir: cloneDir });
  });

  it("offers an npm installation under the home, and nothing at all when nothing exists", () => {
    const paths = tempPaths();
    const packageDir = join(paths.configDir, "node_modules", "@demo", "manager");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@demo/manager" }));
    writeFileSync(join(packageDir, "index.js"), "export function updatePluginPublic() {}\n");

    const found = managerEntries(paths, { id: "demo-manager", npmName: "@demo/manager", source: "cache" });
    expect(found).toEqual([{ entry: join(packageDir, "index.js"), packageDir }]);
    expect(managerEntries(paths, { id: "absent", npmName: "absent", source: "cache" })).toEqual([]);
  });
});

describe("bootstrapCommand", () => {
  it("is the command an operator runs, naming the resolved package and the app", () => {
    expect(bootstrapCommand({ id: "demo-manager", npmName: "@demo/manager", source: "catalog" }, "claude"))
      .toBe("npx -y @demo/manager@latest init --app claude");
  });
});
