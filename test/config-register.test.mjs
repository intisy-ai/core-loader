import { describe, it } from "vitest";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

// config.ts reads PLUGINS_JSON from env.js, derived from HUB_CONFIG_DIR at module evaluation, so the
// home is pinned before the first require.
const configDir = mkdtempSync(join(tmpdir(), "core-loader-register-"));
process.env.HUB_CONFIG_DIR = configDir;

const require = createRequire(import.meta.url);
const { registerPlugin, loadPlugins } = require("../dist/config.js");
const { PLUGINS_JSON } = require("../dist/env.js");

describe("registerPlugin", () => {
  it("adds an enabled auto-updating entry, and reports that it wrote one", () => {
    mkdirSync(join(configDir, "config"), { recursive: true });
    writeFileSync(PLUGINS_JSON, JSON.stringify([]));
    assert.equal(registerPlugin("demo-plugin", "https://github.com/o/demo-plugin.git"), true);
    const listed = JSON.parse(readFileSync(PLUGINS_JSON, "utf8"));
    assert.deepEqual(listed, [{ name: "demo-plugin", url: "https://github.com/o/demo-plugin.git", enabled: true, autoUpdate: true }]);
  });

  it("leaves an already-listed plugin alone", () => {
    assert.equal(registerPlugin("demo-plugin", "https://github.com/o/other.git"), false);
    const listed = JSON.parse(readFileSync(PLUGINS_JSON, "utf8"));
    assert.equal(listed.length, 1);
    assert.equal(listed[0].url, "https://github.com/o/demo-plugin.git");
  });

  // loadPlugins() hides the OTHER app's loader, so registering through it would write the filtered
  // list back and delete that entry from the file.
  it("keeps an entry the reader filters out", () => {
    writeFileSync(PLUGINS_JSON, JSON.stringify([{ name: "claude-code-loader", url: "u", enabled: true }]));
    registerPlugin("fresh-plugin", "https://github.com/o/fresh-plugin.git");
    const names = JSON.parse(readFileSync(PLUGINS_JSON, "utf8")).map((entry) => entry.name);
    assert.ok(names.includes("claude-code-loader"), names.join(","));
    assert.ok(names.includes("fresh-plugin"), names.join(","));
    assert.ok(loadPlugins().length >= 1);
  });
});
