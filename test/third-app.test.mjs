import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

// Every dist module's own compiled require() chain (app-descriptor.js, env.js, state.js, ...) runs
// through Node's native require cache, which vi.resetModules() does not clear (it only resets
// vitest's own module graph for the dynamic import() calls below), so a stale activeDescriptor or a
// stale cache survives from an earlier case unless the whole dist/ subtree is purged here too.
const DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const nodeRequire = createRequire(import.meta.url);
function bustDistRequireCache() {
  for (const key of Object.keys(nodeRequire.cache)) {
    if (key.startsWith(DIST_DIR)) delete nodeRequire.cache[key];
  }
}

// child_process is a Node builtin, never a dist/ path, so bustDistRequireCache never touches it: the
// SAME module object survives every case in this file, real exec included. Captured exactly once so
// a case that stubs it cannot leak a permanently-stubbed exec into a later one.
const cp = nodeRequire("child_process");
const REAL_EXEC = cp.exec;

let dir;
const saved = {};
const KEYS = ["HUB_APPS_FILE", "HUB_CONFIG_DIR", "HUB_APP_ID"];

// The app id this library has never seen, declaring every trait Tasks 12-18 made pluggable.
function zeta(overrides = {}) {
  return {
    id: "zeta", label: "Zeta", home: { candidates: [dir] },
    detect: { binary: "zeta", pkg: "zeta-cli" },
    loader: { id: "zeta-loader", url: "intisy-ai/zeta-loader" },
    accent: "#5f875f",
    wrapperCommand: "zc",
    npmPlugins: { configFiles: ["zeta.json"], pluginsKey: "plugin", packageCache: join(dir, "pkgcache") },
    discovery: { topic: "zeta-plugin" },
    projects: { historyFile: "history.jsonl" },
    ...overrides,
  };
}

function writeRegistry(descriptor) {
  writeFileSync(join(dir, "apps.json"), JSON.stringify({ zeta: descriptor }));
}

// The installed zeta-loader clone whose cairn.json carries the same app descriptor: the settings
// case (config.loaderConfigName()) is discovered through this clone, not through the registry alone.
function installZetaLoaderClone(descriptor) {
  const cloneDir = join(dir, "repos", "zeta-loader");
  mkdirSync(cloneDir, { recursive: true });
  writeFileSync(join(cloneDir, "cairn.json"), JSON.stringify({ app: descriptor }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "core-loader-third-app-"));
  for (const key of KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.HUB_APPS_FILE = join(dir, "apps.json");
  process.env.HUB_CONFIG_DIR = dir;
  process.env.HUB_APP_ID = "zeta";
  bustDistRequireCache();
  vi.resetModules();
});

afterEach(() => {
  cp.exec = REAL_EXEC;
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("an app id no library has ever seen drives every surface", () => {
  it("accent: format.ACCENT is zeta's declared colour's ANSI code, not the neutral default", async () => {
    writeRegistry(zeta());
    const { ACCENT, ansi256FromHex } = await import("../dist/format.js");
    // Verified independently against the library's own nearest-cube-level algorithm: #5f875f is
    // (95,135,95), whose nearest cube indices (1,2,1) give 16 + 36*1 + 6*2 + 1 = 65, not 71.
    expect(ansi256FromHex("#5f875f")).toBe("\x1b[38;5;65m");
    expect(ACCENT).toBe("\x1b[38;5;65m");
    expect(ACCENT).not.toBe("\x1b[38;5;110m");
  });

  it("plugin list: loadNpmPlugins() reads zeta.json's declared key, and answers [] once the trait is gone", async () => {
    writeRegistry(zeta());
    writeFileSync(join(dir, "zeta.json"), JSON.stringify({ plugin: ["some-plugin@1.0.0"] }));
    const { loadNpmPlugins } = await import("../dist/updater.js");
    expect(loadNpmPlugins().map((entry) => entry.name)).toEqual(["some-plugin"]);

    bustDistRequireCache();
    vi.resetModules();
    writeRegistry(zeta({ npmPlugins: undefined }));
    const { loadNpmPlugins: loadNpmPluginsWithoutTrait } = await import("../dist/updater.js");
    expect(loadNpmPluginsWithoutTrait()).toEqual([]);
  });

  it("marketplace: with a declared topic and no awesomeList, the built-in verified list seeds as Curated", () => {
    writeRegistry(zeta());
    bustDistRequireCache();
    const execCalls = [];
    cp.exec = function (cmd) { execCalls.push(cmd); };
    const marketplace = nodeRequire("../dist/marketplace.js");
    const { S } = nodeRequire("../dist/state.js");
    const { FEATURED_PLUGINS } = nodeRequire("../dist/env.js");

    marketplace.fetchCatalogsAsync();

    expect(S.MARKETPLACE_CATALOG.length).toBe(FEATURED_PLUGINS.length);
    expect(S.MARKETPLACE_CATALOG.every((entry) => entry.category === "Curated")).toBe(true);
    expect(S.MARKETPLACE_CATALOG.map((entry) => entry.full_name).sort())
      .toEqual(FEATURED_PLUGINS.map((entry) => entry.full_name).sort());
    expect(execCalls.some((cmd) => cmd.includes("q=topic:zeta-plugin"))).toBe(true);
  });

  it("settings: loaderConfigName() is zeta-loader, and its config file's default_tab is what defaultTab() answers", async () => {
    const descriptor = zeta();
    writeRegistry(descriptor);
    installZetaLoaderClone(descriptor);
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "config", "zeta-loader.json"), JSON.stringify({ default_tab: "mcp" }));

    const { loaderConfigName, defaultTab } = await import("../dist/config.js");
    expect(loaderConfigName()).toBe("zeta-loader");
    expect(defaultTab()).toBe("mcp");
  });

  it("projects: queryProjects() reads the declared historyFile", async () => {
    writeRegistry(zeta());
    const lines = [
      { project: "/repo/beta", sessionId: "s2", timestamp: 200 },
      { project: "/repo/alpha", sessionId: "s1", timestamp: 300 },
    ];
    writeFileSync(join(dir, "history.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");

    const { queryProjects } = await import("../dist/projects.js");
    expect(queryProjects()).toEqual([
      { directory: "/repo/alpha", last_used: 300, sessions: 1 },
      { directory: "/repo/beta", last_used: 200, sessions: 1 },
    ]);
  });

  it("wrapper: the CLI usage line prints the declared wrapperCommand over the CLI's own binary name", () => {
    const home = mkdtempSync(join(tmpdir(), "core-loader-third-app-cli-"));
    const appsFile = join(home, "apps.json");
    writeFileSync(appsFile, JSON.stringify({ zeta: zeta({ home: { candidates: [home] } }) }));
    const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const out = execFileSync(process.execPath, [cliPath], {
      encoding: "utf8",
      env: { ...process.env, HUB_CONFIG_DIR: home, HUB_APPS_FILE: appsFile, HUB_APP_ID: "zeta", HUB_CLI_CMD: "" },
    });
    try { rmSync(home, { recursive: true, force: true }); } catch {}
    expect(out).toMatch(/usage: zc /);
    expect(out).not.toMatch(/usage: zeta /);
  });
});
