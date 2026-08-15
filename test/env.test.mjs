import { describe, it, vi } from "vitest";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
