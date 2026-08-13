import { describe, it } from "vitest";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

// updater.ts's getFolderName reads env.js's REPOS_DIR, derived from HUB_CONFIG_DIR at
// module-evaluation time, so this must be set before the first require() below. Using
// require() (not import) also keeps S the SAME instance getUpdaterVersion/
// clearUpdaterCache mutate internally (see marketplace.test.mjs for why ESM import of
// a CJS dist file is a distinct module instance under vitest).
const configDir = mkdtempSync(join(tmpdir(), "core-loader-updater-"));
process.env.HUB_CONFIG_DIR = configDir;

const require = createRequire(import.meta.url);
const { getFolderName, getUpdaterVersion, clearUpdaterCache } = require("../dist/updater.js");
const { S } = require("../dist/state.js");
const { REPOS_DIR } = require("../dist/env.js");

describe("updater: getFolderName", () => {
  it("returns 'owner/name' when plugin-updater cloned it nested under REPOS_DIR", () => {
    mkdirSync(join(REPOS_DIR, "intisy-ai", "some-plugin"), { recursive: true });
    const folder = getFolderName({ name: "some-plugin", url: "https://github.com/intisy-ai/some-plugin.git" });
    assert.equal(folder, "intisy-ai/some-plugin");
  });

  it("falls back to the flat plugin name when no nested clone exists on disk", () => {
    const folder = getFolderName({ name: "not-cloned", url: "https://github.com/intisy-ai/not-cloned.git" });
    assert.equal(folder, "not-cloned");
  });

  it("falls back to the plugin name when the url isn't a recognizable GitHub URL", () => {
    const folder = getFolderName({ name: "weird-source", url: "https://example.com/weird-source.tar.gz" });
    assert.equal(folder, "weird-source");
  });
});

describe("updater: getUpdaterVersion + clearUpdaterCache", () => {
  it("reads the version from the package directory the resolved entry named", () => {
    const pkgDir = mkdtempSync(join(tmpdir(), "core-loader-updater-pkg-"));
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "9.9.9" }));

    S.UPDATER_MODULE = {};
    S.UPDATER_PATH = pkgDir;
    assert.equal(getUpdaterVersion(), "9.9.9");
  });

  it("returns an empty string when no updater module is loaded", () => {
    S.UPDATER_MODULE = null;
    S.UPDATER_PATH = "";
    assert.equal(getUpdaterVersion(), "");
  });

  it("clearUpdaterCache resets every cached updater field", () => {
    S.UPDATER_MODULE = {}; S.UPDATER_PATH = "x"; S.UPDATER_ENTRY = "y"; S.hasUpdater = true;
    clearUpdaterCache();
    assert.equal(S.UPDATER_MODULE, undefined);
    assert.equal(S.UPDATER_PATH, undefined);
    assert.equal(S.UPDATER_ENTRY, undefined);
    assert.equal(S.hasUpdater, false);
  });
});

describe("updater: the resolved plugin manager", () => {
  it("imports the deployed bundle of whichever plugin declares plugin-management", async () => {
    const { preloadUpdater, getUpdater, getUpdaterPath, getUpdaterVersion, clearUpdaterCache, resolvedManager, managerBootstrapCommand } = require("../dist/updater.js");
    const { PLUGINS_DIR, REPOS_DIR } = require("../dist/env.js");

    mkdirSync(PLUGINS_DIR, { recursive: true });
    // A deployed bundle is ESM, and the plugin dir declares it so, exactly as a real home does.
    writeFileSync(join(PLUGINS_DIR, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(PLUGINS_DIR, "demo-manager.json"), JSON.stringify({ id: "demo-manager", api: 1, entry: "dist/index.js", capabilities: ["plugin-management"] }));
    writeFileSync(join(PLUGINS_DIR, "demo-manager.js"), "export function updatePluginPublic() { return Promise.resolve(); }\n");
    mkdirSync(join(REPOS_DIR, "demo-manager"), { recursive: true });
    writeFileSync(join(REPOS_DIR, "demo-manager", "package.json"), JSON.stringify({ name: "@demo/manager", version: "4.5.6" }));

    clearUpdaterCache();
    const loaded = await preloadUpdater();
    assert.ok(loaded, "the deployed bundle should have been imported");
    assert.equal(typeof getUpdater().updatePluginPublic, "function");
    assert.equal(getUpdaterPath(), join(REPOS_DIR, "demo-manager"));
    assert.equal(getUpdaterVersion(), "4.5.6");
    assert.equal(resolvedManager().id, "demo-manager");
    assert.equal(resolvedManager().npmName, "@demo/manager");
    assert.ok(managerBootstrapCommand().includes("@demo/manager@latest init --app"));
  });

  it("answers null and names no plugin when nothing in the home declares the capability", async () => {
    const { preloadUpdater, getUpdater, clearUpdaterCache, resolvedManager, managerBootstrapCommand } = require("../dist/updater.js");
    const { PLUGINS_DIR, REPOS_DIR, CACHE_DIR } = require("../dist/env.js");
    const emptyHome = mkdtempSync(join(tmpdir(), "core-loader-empty-home-"));
    // The module reads CONFIG_DIR from env.js, pinned above, so an empty home is made by emptying
    // this one: remove the three answers resolution reads.
    rmSync(join(PLUGINS_DIR, "demo-manager.json"), { force: true });
    rmSync(join(REPOS_DIR, "demo-manager"), { recursive: true, force: true });
    rmSync(join(CACHE_DIR, "plugin-manager.json"), { force: true });

    clearUpdaterCache();
    assert.equal(await preloadUpdater(), null);
    assert.equal(getUpdater(), null);
    assert.equal(resolvedManager(), null);
    assert.equal(managerBootstrapCommand(), "");
    assert.ok(existsSync(emptyHome));
  });
});
