import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// config.js's own compiled `require("./env.js")` runs through Node's native require cache, which
// vi.resetModules() does not clear (it only resets vitest's own module graph for the dynamic
// import() below), so a stale env.js survives from an earlier test unless purged here too.
const DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const nodeRequire = createRequire(import.meta.url);
function bustDistRequireCache() {
  for (const key of Object.keys(nodeRequire.cache)) {
    if (key.startsWith(DIST_DIR)) delete nodeRequire.cache[key];
  }
}

let dir;
const saved = {};
const KEYS = ["HUB_APPS_FILE", "HUB_CONFIG_DIR", "HUB_APP_ID", "HUB_CLI_CMD"];

function home(withClone) {
  mkdirSync(join(dir, "config"), { recursive: true });
  if (withClone) {
    mkdirSync(join(dir, "repos", "zeta-loader"), { recursive: true });
    writeFileSync(join(dir, "repos", "zeta-loader", "plugin.json"), JSON.stringify({
      id: "zeta-loader-id",
      api: 1,
      app: { id: "zeta", label: "Zeta", home: { candidates: [dir] }, loader: { id: "zeta-loader", url: "u" } },
    }));
  }
  writeFileSync(join(dir, "apps.json"), JSON.stringify({ zeta: { id: "zeta", label: "Zeta", home: { candidates: [dir] } } }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "core-loader-loaderconfig-"));
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

describe("the active loader's own config", () => {
  it("is named by the clone that declares this app", async () => {
    home(true);
    const { loaderConfigName } = await import("../dist/config.js");
    expect(loaderConfigName()).toBe("zeta-loader");
  });

  it("is read from config/<that name>.json", async () => {
    home(true);
    writeFileSync(join(dir, "config", "zeta-loader.json"), JSON.stringify({ default_tab: "plugins", update_check_interval_hours: 3 }));
    const { defaultTab, updateCheckIntervalHours } = await import("../dist/config.js");
    expect(defaultTab()).toBe("plugins");
    expect(updateCheckIntervalHours()).toBe(3);
  });

  it("falls back to the defaults when this home holds no such file", async () => {
    home(true);
    const { defaultTab, updateCheckIntervalHours } = await import("../dist/config.js");
    expect(defaultTab()).toBe("projects");
    expect(updateCheckIntervalHours()).toBe(24);
  });

  it("reads no other app's loader config when no clone declares this app", async () => {
    home(false);
    writeFileSync(join(dir, "config", "other-loader.json"), JSON.stringify({ default_tab: "plugins" }));
    const { defaultTab } = await import("../dist/config.js");
    expect(defaultTab()).toBe("projects");
  });
});
