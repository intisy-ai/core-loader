import { describe, it, afterEach } from "vitest";
import assert from "node:assert";
import { createRequire } from "node:module";

// See marketplace.test.mjs for why this must be require(), not import: getPluginActions
// reads S.capabilities through its own internal require("./state.js"), which is a
// DIFFERENT module instance than an ESM import of the same dist path under vitest.
const require = createRequire(import.meta.url);
const { buildConfigItems, getPluginActions } = require("../dist/plugins.js");
const { S } = require("../dist/state.js");

afterEach(() => { S.capabilities = {}; });

describe("plugins: buildConfigItems", () => {
  it("merges defaults with current values, tracking which keys are explicitly set and their type", () => {
    const items = buildConfigItems({ defaults: { logging: true, port: 3000 }, current: { port: 4000 } });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    assert.equal(byKey.logging.value, true);
    assert.equal(byKey.logging.isSet, false);
    assert.equal(byKey.logging.type, "boolean");
    assert.equal(byKey.port.value, 4000);
    assert.equal(byKey.port.isSet, true);
    assert.equal(byKey.port.type, "number");
  });
});

describe("plugins: buildConfigItems structure", () => {
  it("leaves a nested object out, because a text row would corrupt it", () => {
    const items = buildConfigItems({
      defaults: { auto_update_mode: "update", auto_update_triggers: { loader: true }, logging: true },
      current: {},
    });
    const keys = items.map((i) => i.key).sort();
    assert.deepEqual(keys, ["auto_update_mode", "logging"]);
  });

  it("keeps a null value, which is editable as text", () => {
    const items = buildConfigItems({ defaults: { token: null }, current: {} });
    assert.deepEqual(items.map((i) => i.key), ["token"]);
  });

  it("adds a row for a declared key that addresses a leaf inside a nested object", () => {
    const items = buildConfigItems({
      defaults: { categories: { accounts: true, plugins: true }, logging: true },
      current: { categories: { accounts: false } },
      fields: [{ key: "categories.accounts", type: "boolean" }, { key: "categories.plugins", type: "boolean" }],
    });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    assert.deepEqual(Object.keys(byKey).sort(), ["categories.accounts", "categories.plugins", "logging"]);
    assert.equal(byKey["categories.accounts"].value, false);
    assert.equal(byKey["categories.accounts"].isSet, true);
    assert.equal(byKey["categories.plugins"].value, true);
    assert.equal(byKey["categories.plugins"].isSet, false);
  });

  it("ignores a declared nested key that resolves to nothing, or to another object", () => {
    const items = buildConfigItems({
      defaults: { categories: { accounts: true }, nested: { deep: { a: 1 } } },
      current: {},
      fields: [{ key: "categories.missing", type: "boolean" }, { key: "nested.deep", type: "string" }],
    });
    assert.deepEqual(items.map((i) => i.key), []);
  });
});

describe("plugins: getPluginActions", () => {
  it("a foreign (host-app-native) plugin only offers actions its registered capabilities support", () => {
    S.capabilities = {};
    assert.deepEqual(getPluginActions({ foreign: true, enabled: true }).map((a) => a.key), ["cancel"]);

    S.capabilities = { setForeignPluginEnabled: () => {}, uninstallForeignPlugin: () => {} };
    const acts = getPluginActions({ foreign: true, enabled: true });
    assert.deepEqual(acts.map((a) => a.key), ["foreign-toggle", "foreign-uninstall", "cancel"]);
    assert.equal(acts[0].label, "Disable plugin");
  });

  it("an npm plugin offers update/uninstall, and no configure without a settings declaration", () => {
    const noDeclaration = getPluginActions({ type: "npm" });
    assert.deepEqual(noDeclaration.map((a) => a.key), ["update-npm", "uninstall-npm", "cancel"]);
  });

  it("a disabled plugin only offers enable + cancel, no update/settings actions", () => {
    assert.deepEqual(getPluginActions({ enabled: false }).map((a) => a.key), ["enable-plugin", "cancel"]);
  });

  it("an enabled plugin's auto-update toggle label reflects its current autoUpdate flag", () => {
    const auto = getPluginActions({ enabled: true, autoUpdate: true, deployed: true });
    const manual = getPluginActions({ enabled: true, autoUpdate: false, deployed: true });
    assert.equal(auto.find((a) => a.key === "disable-auto").label, "Set to manual update");
    assert.equal(manual.find((a) => a.key === "enable-auto").label, "Enable auto-update");
  });

  it("offers switching to experimental only when detection is a definite yes and the plugin isn't on it yet", () => {
    const onStable = getPluginActions({ enabled: true, experimentalAvailable: true, onExperimental: false });
    assert.ok(onStable.some((a) => a.key === "channel-experimental"));
    assert.ok(!onStable.some((a) => a.key === "channel-stable"));
  });

  it("offers switching back to stable when the RESOLVED state already has it on the channel", () => {
    const onExperimental = getPluginActions({ enabled: true, experimentalAvailable: true, onExperimental: true });
    assert.ok(onExperimental.some((a) => a.key === "channel-stable"));
    assert.ok(!onExperimental.some((a) => a.key === "channel-experimental"));
  });

  it("offers neither channel action when availability is unknown or false", () => {
    const unknown = getPluginActions({ enabled: true, experimentalAvailable: null, onExperimental: false });
    const unavailable = getPluginActions({ enabled: true, experimentalAvailable: false, onExperimental: false });
    assert.ok(!unknown.some((a) => a.key === "channel-experimental" || a.key === "channel-stable"));
    assert.ok(!unavailable.some((a) => a.key === "channel-experimental" || a.key === "channel-stable"));
  });
});
