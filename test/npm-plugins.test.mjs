import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// updater.js's own compiled `require("./app-descriptor.js")` runs through Node's native require
// cache, which vi.resetModules() does not clear (it only resets vitest's own module graph for the
// dynamic import() below), so a stale app-descriptor.js (with its cached activeDescriptor) survives
// from an earlier test unless purged here too.
const DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const nodeRequire = createRequire(import.meta.url);
function bustDistRequireCache() {
  for (const key of Object.keys(nodeRequire.cache)) {
    if (key.startsWith(DIST_DIR)) delete nodeRequire.cache[key];
  }
}

let dir;
const saved = {};
const KEYS = ["HUB_APPS_FILE", "HUB_CONFIG_DIR", "HUB_APP_ID"];

function registry(npmPlugins) {
  writeFileSync(join(dir, "apps.json"), JSON.stringify({
    zeta: { id: "zeta", label: "Zeta", home: { candidates: [dir] }, ...(npmPlugins ? { npmPlugins } : {}) },
  }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "core-loader-npm-"));
  for (const key of KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.HUB_APPS_FILE = join(dir, "apps.json");
  process.env.HUB_CONFIG_DIR = dir;
  process.env.HUB_APP_ID = "zeta";
  bustDistRequireCache();
  vi.resetModules();
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("an app with no declared npm-plugin mechanism", () => {
  it("lists no npm plugins even when a config file happens to sit in its home", async () => {
    registry(null);
    writeFileSync(join(dir, "zeta.json"), JSON.stringify({ plugin: ["some-plugin@1.0.0"] }));
    const { loadNpmPlugins } = await import("../dist/updater.js");
    expect(loadNpmPlugins()).toEqual([]);
  });
});

describe("an app that declares one", () => {
  it("reads its plugin list from the declared file and key", async () => {
    registry({ configFiles: ["zeta.json"], pluginsKey: "plugin" });
    writeFileSync(join(dir, "zeta.json"), JSON.stringify({ plugin: ["some-plugin@1.0.0"] }));
    const { loadNpmPlugins } = await import("../dist/updater.js");
    expect(loadNpmPlugins().map((entry) => entry.name)).toEqual(["some-plugin"]);
  });

  it("prefers the first declared file that exists", async () => {
    registry({ configFiles: ["zeta.jsonc", "zeta.json"], pluginsKey: "plugin" });
    writeFileSync(join(dir, "zeta.json"), JSON.stringify({ plugin: ["from-json"] }));
    const { loadNpmPlugins } = await import("../dist/updater.js");
    expect(loadNpmPlugins().map((entry) => entry.name)).toEqual(["from-json"]);
  });

  it("finds a plugin's version in the declared package cache", async () => {
    registry({ configFiles: ["zeta.json"], pluginsKey: "plugin", packageCache: join(dir, "pkgcache") });
    writeFileSync(join(dir, "zeta.json"), JSON.stringify({ plugin: ["some-plugin@1.0.0"] }));
    mkdirSync(join(dir, "pkgcache", "some-plugin@1.0.0", "node_modules", "some-plugin"), { recursive: true });
    writeFileSync(join(dir, "pkgcache", "some-plugin@1.0.0", "node_modules", "some-plugin", "package.json"), JSON.stringify({ version: "1.0.0" }));
    const { loadNpmPlugins } = await import("../dist/updater.js");
    expect(loadNpmPlugins()[0].version).toBe("1.0.0");
  });
});
