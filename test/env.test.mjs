import { describe, it } from "vitest";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
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
  MCP_CONFIG_PATH, CATALOG_CACHE_PATH, SEED_CACHE_PATH, IS_CLAUDE,
  MCP_CATALOG, OFFICIAL_PLUGINS, FEATURED_PLUGINS,
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

  it("detects Claude Code from HUB_CLI_CMD/HUB_APP_NAME", () => {
    assert.equal(IS_CLAUDE, true);
  });
});

describe("env: static catalogs", () => {
  it("marks every MCP_CATALOG entry curated, pre-seeding full_name for known repos", () => {
    assert.ok(MCP_CATALOG.length > 0);
    assert.ok(MCP_CATALOG.every((e) => e.curated === true));
    const github = MCP_CATALOG.find((e) => e.name === "github");
    assert.equal(github.full_name, "modelcontextprotocol/servers");
  });

  it("marks every OFFICIAL_PLUGINS entry official", () => {
    assert.ok(OFFICIAL_PLUGINS.length > 0);
    assert.ok(OFFICIAL_PLUGINS.every((e) => e.official === true));
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
