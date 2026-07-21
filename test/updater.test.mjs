import { describe, it } from "vitest";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
  it("reads the version from the updater's package.json, both index.js-sibling and directory forms", () => {
    const pkgDir = mkdtempSync(join(tmpdir(), "core-loader-updater-pkg-"));
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "9.9.9" }));

    S.UPDATER_MODULE = {};
    S.UPDATER_PATH = join(pkgDir, "index.js");
    assert.equal(getUpdaterVersion(), "9.9.9");

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
