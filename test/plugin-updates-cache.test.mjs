import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

// buildPluginList reads env.js's REPOS_DIR, which is derived from HUB_CONFIG_DIR at
// module-evaluation time, so the fake configDir must be set up and the env var
// assigned BEFORE the first import of dist/plugins.js in this file. Each vitest test
// file gets its own isolated module registry, so this is safe without touching any
// other test file's env/module state.
const configDir = mkdtempSync(join(tmpdir(), "core-loader-plugin-cache-"));
mkdirSync(join(configDir, "config"), { recursive: true });
mkdirSync(join(configDir, "cache"), { recursive: true });
process.env.HUB_CONFIG_DIR = configDir;

writeFileSync(
  join(configDir, "config", "plugins.json"),
  JSON.stringify([
    { name: "behind-plugin", url: "https://github.com/intisy-ai/behind-plugin.git", enabled: true, autoUpdate: true },
    { name: "current-plugin", url: "https://github.com/intisy-ai/current-plugin.git", enabled: true, autoUpdate: true },
    { name: "unchecked-plugin", url: "https://github.com/intisy-ai/unchecked-plugin.git", enabled: true, autoUpdate: true },
  ]),
);

const checkedAt = "2026-07-18T19:00:00.000Z";
writeFileSync(
  join(configDir, "cache", "plugin-updates.json"),
  JSON.stringify({
    checkedAt,
    plugins: {
      "behind-plugin": {
        kind: "git", installedVersion: null, localHead: "a".repeat(40), remoteHead: "b".repeat(40),
        latestVersion: null, updateAvailable: true, updatedAt: null,
      },
      "current-plugin": {
        kind: "git", installedVersion: null, localHead: "c".repeat(40), remoteHead: "c".repeat(40),
        latestVersion: null, updateAvailable: false, updatedAt: checkedAt,
      },
      // unchecked-plugin has no entry at all -> buildPluginList must fall back to false
    },
  }),
);

// require(), not import(): vitest's module runner gives an ESM import of a CJS dist
// file a different instance than the function-under-test's own internal require(), so
// stubbing S via import silently wouldn't reach buildPluginList (see marketplace.test.mjs).
const require = createRequire(import.meta.url);
const { buildPluginList } = require("../dist/plugins.js");
const { S } = require("../dist/state.js");

describe("plugin-updates cache drives buildPluginList", () => {
  it("sets updateAvail (and remoteHead/updatedAt) from cache.plugins[name], false when the plugin has no cache entry", () => {
    const list = buildPluginList();
    const byName = Object.fromEntries(list.map((p) => [p.name, p]));

    assert.equal(byName["behind-plugin"].updateAvail, true);
    assert.equal(byName["behind-plugin"].remoteHead, "b".repeat(40));

    assert.equal(byName["current-plugin"].updateAvail, false);
    assert.equal(byName["current-plugin"].updatedAt, checkedAt);

    assert.equal(byName["unchecked-plugin"].updateAvail, false);
    assert.equal(byName["unchecked-plugin"].updatedAt, null);
  });
});

describe("pluginChannelState drives buildPluginList's channel fields", () => {
  let previous;
  beforeEach(() => {
    previous = S.UPDATER_MODULE;
  });
  afterEach(() => {
    S.UPDATER_MODULE = previous;
  });

  it("carries the updater's resolved onExperimental/experimentalAvailable onto the item, called with this home's configDir and the plugin's name", () => {
    const calls = [];
    S.UPDATER_MODULE = {
      pluginChannelState(dir, name) {
        calls.push([dir, name]);
        return name === "current-plugin"
          ? { onExperimental: true, experimentalAvailable: true }
          : { onExperimental: false, experimentalAvailable: false };
      },
    };

    const list = buildPluginList();
    const byName = Object.fromEntries(list.map((p) => [p.name, p]));

    assert.equal(byName["current-plugin"].onExperimental, true);
    assert.equal(byName["current-plugin"].experimentalAvailable, true);

    // Case 2 stops case 1 from passing for the wrong reason (a hardcoded true).
    assert.equal(byName["behind-plugin"].onExperimental, false);
    assert.equal(byName["behind-plugin"].experimentalAvailable, false);

    assert.deepEqual(calls.find((c) => c[1] === "current-plugin"), [configDir, "current-plugin"]);
    assert.deepEqual(calls.find((c) => c[1] === "behind-plugin"), [configDir, "behind-plugin"]);
  });

  it("falls back to onExperimental: false, experimentalAvailable: null when no updater is loaded", () => {
    S.UPDATER_MODULE = null;

    const list = buildPluginList();
    const byName = Object.fromEntries(list.map((p) => [p.name, p]));

    assert.equal(byName["current-plugin"].onExperimental, false);
    assert.equal(byName["current-plugin"].experimentalAvailable, null);
  });
});
