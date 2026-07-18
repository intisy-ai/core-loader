import { describe, it } from "vitest";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Separate file (own isolated module registry) from plugin-updates-cache.test.mjs so
// this configDir (no cache/plugin-updates.json at all) can never collide with the
// other file's already-imported, differently-configured module graph.
const configDir = mkdtempSync(join(tmpdir(), "core-loader-plugin-cache-absent-"));
mkdirSync(join(configDir, "config"), { recursive: true });
process.env.HUB_CONFIG_DIR = configDir;

writeFileSync(
  join(configDir, "config", "plugins.json"),
  JSON.stringify([{ name: "no-cache-plugin", url: "https://github.com/intisy-ai/no-cache-plugin.git", enabled: true, autoUpdate: true }]),
);
// deliberately no cache/plugin-updates.json written

const { buildPluginList, readUpdateCache } = await import("../dist/plugins.js");

describe("plugin-updates cache absent falls back to current behavior", () => {
  it("readUpdateCache returns null and updateAvail stays false when the cache file doesn't exist", () => {
    assert.equal(readUpdateCache(), null);
    const list = buildPluginList();
    assert.equal(list[0].updateAvail, false);
  });
});
