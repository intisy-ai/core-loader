import { describe, it, afterEach } from "vitest";
import assert from "node:assert";
import { createRequire } from "node:module";

// Vitest's module runner gives an ESM `import` of a CJS dist file a DIFFERENT module
// instance than a plain `require()` of the same path, so mutating a singleton (S) via
// import and reading it back through the function-under-test's own internal require()
// would silently no-op. Loading both the functions and the shared state through the
// SAME createRequire() keeps them on one real Node require cache, matching how
// marketplace.js itself requires state.js.
const require = createRequire(import.meta.url);
const { parseSeedPlugins, selectInstallMethod, getMarketplaceActions } = require("../dist/marketplace.js");
const { S } = require("../dist/state.js");

afterEach(() => { S.capabilities = {}; });

describe("marketplace: parseSeedPlugins", () => {
  it("maps a seed marketplace.json's plugins array, defaulting missing fields", () => {
    const json = { plugins: [{ name: "foo", description: "bar" }, { name: "baz" }] };
    assert.deepEqual(parseSeedPlugins(json, "my-seed"), [
      { id: "foo", name: "foo", description: "bar", source: "my-seed" },
      { id: "baz", name: "baz", description: "", source: "my-seed" },
    ]);
  });

  it("returns [] for a missing/malformed plugins array, never throws", () => {
    assert.deepEqual(parseSeedPlugins({}, "s"), []);
    assert.deepEqual(parseSeedPlugins({ plugins: "nope" }, "s"), []);
    assert.deepEqual(parseSeedPlugins(null, "s"), []);
  });
});

describe("marketplace: selectInstallMethod", () => {
  it("prefers git via the updater unless the entry hints npm or no updater is loadable", () => {
    assert.equal(selectInstallMethod({}, true), "git");
    assert.equal(selectInstallMethod({ install: "npm" }, true), "npm");
    assert.equal(selectInstallMethod({}, false), "npm");
  });
});

describe("marketplace: getMarketplaceActions", () => {
  it("a seed row offers install-seed only when both addMarketplace + installAppPlugin are registered", () => {
    S.capabilities = {};
    assert.deepEqual(getMarketplaceActions({ seed: true, source: "o/r" }, false).map((a) => a.key), ["cancel"]);

    S.capabilities = { addMarketplace: () => {}, installAppPlugin: () => {} };
    const withCaps = getMarketplaceActions({ seed: true, source: "o/r" }, false);
    assert.deepEqual(withCaps.map((a) => a.key), ["install-seed", "cancel"]);
    assert.ok(withCaps[0].label.includes("o/r"));
  });

  it("a capability row offers install-app only when not already installed", () => {
    S.capabilities = { installAppPlugin: () => {} };
    assert.deepEqual(getMarketplaceActions({ capability: true, installed: false }, false).map((a) => a.key), ["install-app", "cancel"]);
    assert.deepEqual(getMarketplaceActions({ capability: true, installed: true }, false).map((a) => a.key), ["cancel"]);
  });

  it("an already-installed catalog item offers no install action; one with a url and an updater gets install-git + browser", () => {
    S.capabilities = {};
    assert.deepEqual(getMarketplaceActions({ installed: true }, false).map((a) => a.key), ["cancel"]);

    const withUrl = getMarketplaceActions({ url: "https://x" }, true);
    assert.ok(withUrl.some((a) => a.key === "install-git"));
    assert.ok(withUrl.some((a) => a.key === "browser"));
    assert.ok(withUrl.some((a) => a.key === "cancel"));
  });
});
