import { describe, it, vi } from "vitest";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// config.js's own compiled `require("./env.js")` runs through Node's native require cache, which
// vi.resetModules() does not clear, so a stale CONFIG_DIR survives from an earlier test unless
// purged here too.
const DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const nodeRequire = createRequire(import.meta.url);
function bustDistRequireCache() {
  for (const key of Object.keys(nodeRequire.cache)) {
    if (key.startsWith(DIST_DIR)) delete nodeRequire.cache[key];
  }
}

const HOME_RELATIVE_PATHS = [
  "CONFIG_FOLDER", "CACHE_DIR", "CONFIG_PATH", "UPDATE_CHECK_PATH", "PLUGINS_JSON",
  "REPOS_DIR", "PLUGINS_DIR", "MCP_CONFIG_PATH", "CATALOG_CACHE_PATH", "SEED_CACHE_PATH",
  "CACHE_PKG_DIR",
];

const ENV_KEYS = ["HUB_APP_ID", "HUB_CONFIG_DIR", "HUB_APPS_FILE", "HUB_APP_NAME", "HUB_CLI_CMD"];

async function withPinnedEnv(overrides, body) {
  const saved = {};
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  bustDistRequireCache();
  vi.resetModules();
  try {
    return await body();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    bustDistRequireCache();
    vi.resetModules();
  }
}

function runEverySave(config) {
  config.saveConfig({ pinned: ["/repo/alpha"], hidden: [] });
  config.savePlugins([{ name: "demo", url: "https://example.invalid/demo.git", enabled: true, autoUpdate: true }]);
  config.setGlobalSetting("logConsole", "true");
  config.saveMcpConfig({ mcpServers: { demo: {} } });
  config.migrateConfigs();
}

// env.ts derives every path constant from HUB_CONFIG_DIR at module-evaluation time,
// so the env var must be set (to an isolated temp dir, never the real ~/.config)
// before the FIRST import of dist/env.js in this file.
const configDir = mkdtempSync(join(tmpdir(), "core-loader-env-"));
process.env.HUB_CONFIG_DIR = configDir;
process.env.HUB_CLI_CMD = "claude";
process.env.HUB_APP_NAME = "Claude Code";

const {
  CONFIG_DIR, CONFIG_FOLDER, CACHE_DIR, PLUGINS_JSON, REPOS_DIR, PLUGINS_DIR,
  MCP_CONFIG_PATH, CATALOG_CACHE_PATH, SEED_CACHE_PATH,
  MCP_CATALOG, FEATURED_PLUGINS,
} = await import("../dist/env.js");

describe("env: path helpers", () => {
  it("derives every config-dir-relative path from HUB_CONFIG_DIR, never the real home", () => {
    assert.equal(CONFIG_DIR, configDir);
    assert.equal(CONFIG_FOLDER, join(configDir, "config"));
    assert.equal(CACHE_DIR, join(configDir, "cache"));
    assert.equal(REPOS_DIR, join(configDir, "repos"));
    assert.equal(PLUGINS_DIR, join(configDir, "plugin"));
    assert.equal(PLUGINS_JSON, join(configDir, "config", "plugins.json"));
    assert.equal(MCP_CONFIG_PATH, join(configDir, ".mcp.json"));
    assert.equal(CATALOG_CACHE_PATH, join(configDir, "cache", "marketplace-catalog.json"));
    assert.equal(SEED_CACHE_PATH, join(configDir, "cache", "seed-marketplaces.json"));
  });
});

describe("an app nothing injected and nothing declares", () => {
  it("resolves to no id, no name and no home rather than to a default app", async () => {
    const dir = mkdtempSync(join(tmpdir(), "core-loader-env-unknown-"));
    writeFileSync(join(dir, "apps.json"), "{}");
    const saved = { id: process.env.HUB_APP_ID, cfg: process.env.HUB_CONFIG_DIR, apps: process.env.HUB_APPS_FILE, name: process.env.HUB_APP_NAME, cli: process.env.HUB_CLI_CMD };
    delete process.env.HUB_APP_ID; delete process.env.HUB_CONFIG_DIR; delete process.env.HUB_APP_NAME; delete process.env.HUB_CLI_CMD;
    process.env.HUB_APPS_FILE = join(dir, "apps.json");
    vi.resetModules();
    const env = await import("../dist/env.js");
    assert.equal(env.APP_ID, "");
    assert.equal(env.APP_NAME, "");
    assert.equal(env.CONFIG_DIR, "");
    for (const [key, value] of Object.entries({ HUB_APP_ID: saved.id, HUB_CONFIG_DIR: saved.cfg, HUB_APPS_FILE: saved.apps, HUB_APP_NAME: saved.name, HUB_CLI_CMD: saved.cli })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("takes its name, binary and home from the declared descriptor when only the id is injected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "core-loader-env-declared-"));
    mkdirSync(join(dir, "home"), { recursive: true });
    writeFileSync(join(dir, "apps.json"), JSON.stringify({
      zeta: { id: "zeta", label: "Zeta", home: { candidates: [join(dir, "home")] }, detect: { binary: "zeta", pkg: "zeta-cli" } },
    }));
    const saved = { id: process.env.HUB_APP_ID, cfg: process.env.HUB_CONFIG_DIR, apps: process.env.HUB_APPS_FILE, name: process.env.HUB_APP_NAME, cli: process.env.HUB_CLI_CMD };
    delete process.env.HUB_CONFIG_DIR; delete process.env.HUB_APP_NAME; delete process.env.HUB_CLI_CMD;
    process.env.HUB_APP_ID = "zeta";
    process.env.HUB_APPS_FILE = join(dir, "apps.json");
    vi.resetModules();
    const env = await import("../dist/env.js");
    assert.equal(env.APP_NAME, "Zeta");
    assert.equal(env.CLI_CMD, "zeta");
    assert.equal(env.NPM_PKG, "zeta-cli");
    assert.equal(env.CONFIG_DIR, join(dir, "home"));
    for (const [key, value] of Object.entries({ HUB_APP_ID: saved.id, HUB_CONFIG_DIR: saved.cfg, HUB_APPS_FILE: saved.apps, HUB_APP_NAME: saved.name, HUB_CLI_CMD: saved.cli })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("an app with no home", () => {
  it("derives every home-relative path as empty rather than as a working-directory-relative one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "core-loader-env-nohome-"));
    writeFileSync(join(dir, "apps.json"), "{}");
    await withPinnedEnv({ HUB_APPS_FILE: join(dir, "apps.json") }, async () => {
      const env = await import("../dist/env.js");
      assert.equal(env.CONFIG_DIR, "");
      for (const name of HOME_RELATIVE_PATHS) {
        assert.equal(env[name], "", name + " must be empty so it cannot resolve against the working directory");
      }
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes nothing anywhere when every save runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "core-loader-env-nowrite-"));
    writeFileSync(join(dir, "apps.json"), "{}");
    // Saves land on a relative path when the guards are missing, so the assertion has to watch the
    // working directory itself, not the app home.
    const scratch = mkdtempSync(join(tmpdir(), "core-loader-env-cwd-"));
    const originalCwd = process.cwd();
    process.chdir(scratch);
    try {
      await withPinnedEnv({ HUB_APPS_FILE: join(dir, "apps.json") }, async () => {
        const config = await import("../dist/config.js");
        runEverySave(config);
        assert.deepEqual(config.loadPlugins(), []);
        assert.deepEqual(config.loadConfig(), { pinned: [], hidden: [] });
      });
      assert.deepEqual(readdirSync(scratch), [], "an unknown app must write nothing into the working directory");
    } finally {
      process.chdir(originalCwd);
      rmSync(scratch, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("an app with a real home", () => {
  it("keeps every derived path under it and lands every save there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "core-loader-env-realhome-"));
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(dir, "apps.json"), "{}");
    const scratch = mkdtempSync(join(tmpdir(), "core-loader-env-realcwd-"));
    const originalCwd = process.cwd();
    process.chdir(scratch);
    try {
      await withPinnedEnv({ HUB_APPS_FILE: join(dir, "apps.json"), HUB_CONFIG_DIR: home }, async () => {
        const env = await import("../dist/env.js");
        assert.equal(env.CONFIG_DIR, home);
        assert.equal(env.CONFIG_FOLDER, join(home, "config"));
        assert.equal(env.CACHE_DIR, join(home, "cache"));
        assert.equal(env.CONFIG_PATH, join(home, "config", "oc-config.json"));
        assert.equal(env.UPDATE_CHECK_PATH, join(home, "cache", "oc-last-update-check"));
        assert.equal(env.PLUGINS_JSON, join(home, "config", "plugins.json"));
        assert.equal(env.REPOS_DIR, join(home, "repos"));
        assert.equal(env.PLUGINS_DIR, join(home, "plugin"));
        assert.equal(env.MCP_CONFIG_PATH, join(home, ".mcp.json"));
        assert.equal(env.CATALOG_CACHE_PATH, join(home, "cache", "marketplace-catalog.json"));
        assert.equal(env.SEED_CACHE_PATH, join(home, "cache", "seed-marketplaces.json"));
        assert.equal(env.CACHE_PKG_DIR, join(home, "cache", "node_modules"));

        const config = await import("../dist/config.js");
        runEverySave(config);
        assert.deepEqual(JSON.parse(readFileSync(join(home, "config", "oc-config.json"), "utf8")), { pinned: ["/repo/alpha"], hidden: [] });
        assert.equal(JSON.parse(readFileSync(join(home, "config", "plugins.json"), "utf8"))[0].name, "demo");
        assert.equal(JSON.parse(readFileSync(join(home, "config", "settings.json"), "utf8")).logConsole, true);
        assert.ok(existsSync(join(home, ".mcp.json")));
      });
      assert.deepEqual(readdirSync(scratch), [], "a save must land in the app home, never in the working directory");
    } finally {
      process.chdir(originalCwd);
      rmSync(scratch, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("env: static catalogs", () => {
  it("marks every MCP_CATALOG entry curated, pre-seeding full_name for known repos", () => {
    assert.ok(MCP_CATALOG.length > 0);
    assert.ok(MCP_CATALOG.every((e) => e.curated === true));
    const github = MCP_CATALOG.find((e) => e.name === "github");
    assert.equal(github.full_name, "modelcontextprotocol/servers");
  });

  it("derives FEATURED_PLUGINS' author/repoName/full_name/url/category from its repo field", () => {
    const cartographer = FEATURED_PLUGINS.find((e) => e.name === "cartographer");
    assert.equal(cartographer.author, "kingbootoshi");
    assert.equal(cartographer.repoName, "cartographer");
    assert.equal(cartographer.full_name, "kingbootoshi/cartographer");
    assert.equal(cartographer.url, "https://github.com/kingbootoshi/cartographer.git");
    assert.equal(cartographer.category, "Codebase");
  });
});
