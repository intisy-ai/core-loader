// The Settings tab renders whatever a plugin declared: its contributed sections carry the
// plugin's name, and an action shows as a row you run rather than a value you edit.
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { S } = require("../dist/state.js");
const { buildSettings } = require("../dist/views/settings.js");
const { buildSettingsEntries, splitBySections } = require("../dist/settings-model.js");

const STRIP = /\[[0-9;]*m/g;

function render() {
  const body = [];
  const foot = [];
  buildSettings((line) => body.push(String(line).replace(STRIP, "")), (line) => foot.push(String(line).replace(STRIP, "")), 120, 110, () => {});
  return { body, foot };
}

function declarationWithSection() {
  return {
    name: "sync-bridge",
    bundle: "/plugins/sync-bridge.js",
    items: [
      { key: "logging", value: true, def: true, isSet: false, type: "boolean" },
      { key: "enabled", value: true, def: true, isSet: false, type: "boolean" },
    ],
    actions: [{ id: "sync", label: "Sync now" }],
    sections: [{ id: "sync", label: "Sync", order: 40, fields: ["enabled"], actions: ["sync"] }],
  };
}

// The tab renders whatever the section model resolved, so a view test states that model
// directly rather than standing up a host to read one declaration back.
function seedSections() {
  const sections = splitBySections(declarationWithSection());
  S.settingsSections = sections;
  S.settingsEntries = buildSettingsEntries(sections);
  S.settingsCursor = 0;
}

let saved;
beforeEach(() => {
  saved = { page: S.page, mode: S.mode, sub: S.settingsSubPage, capabilities: S.capabilities };
  S.capabilities = {};
  S.page = "settings";
  S.mode = "list";
  S.settingsSubPage = "settings";
  S.settingsCursor = 0;
  S.configTarget = null;
  S.configConfirm = null;
});
afterEach(() => {
  S.page = saved.page;
  S.mode = saved.mode;
  S.settingsSubPage = saved.sub;
  S.capabilities = saved.capabilities;
  S.settingsEntries = null;
});

// Running an action from a contributed screen arms the busy gate, which drops every keystroke until
// it is released. Driven through the real key handler against a real host, because the release is
// split across two modules and only the whole path shows whether it happens.
describe("a contributed screen's action", () => {
  const { startPlugins } = require("../dist/plugin-host.js");
  const { resetPluginHostForTests } = require("../dist/plugin-surface.js");
  const { handleSettingsKey } = require("../dist/input.js");

  const screenSpec = { id: "s", label: "S", layout: { kind: "stack", children: [{ kind: "text", text: "hi" }] } };

  function runtime() {
    return {
      config: { all: () => ({}), get: () => undefined, set: async () => {} },
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      paths: { home: "/home", repos: "/home/repos", plugin: "/home/plugin", cache: "/home/cache", config: "/home/config" },
      events: { publish: () => {}, subscribe: () => () => {} },
    };
  }

  // An ActionResult is a live object the plugin still owns, so reading a field of it can run the
  // plugin's code: this one throws on the way to reporting the result rather than inside the report.
  const hostileResult = {
    ok: true,
    message: "did it",
    get refresh() { throw new Error("refresh exploded"); },
  };

  async function hostWith(invoke) {
    const loaded = await startPlugins({
      app: "test",
      pluginDir: "/home/plugin",
      surfaces: ["tui"],
      runtimeFor: () => runtime(),
      scan: {
        loaded: [{
          manifest: { id: "doer", api: 1, entry: "dist/index.js", capabilities: ["screens"] },
          manifestPath: "/home/plugin/doer.json",
          entryPath: "/home/plugin/doer.js",
        }],
        failed: [],
      },
      importEntry: async () => ({
        default: {
          activate: (ctx) => ctx.provide("screens", {
            screens: () => [screenSpec],
            read: async () => ({ sources: {} }),
            invoke,
          }),
          deactivate: () => {},
        },
      }),
    });
    resetPluginHostForTests(loaded);
  }

  function openScreenWithOneAction() {
    S.screenSpecs = [{ plugin: "doer", spec: screenSpec, actions: [] }];
    S.settingsSubPage = "doer:s";
    S.screenRows = [{ text: "Go", depth: 0, actionId: "go" }];
    S.screenCursor = 0;
  }

  afterEach(() => {
    resetPluginHostForTests(null);
    S.screenSpecs = [];
    S.screenRows = [];
    S.screenFailed = null;
    S.busy = false;
    if (S.msgTimeout) { clearTimeout(S.msgTimeout); S.msgTimeout = null; }
    if (S.renderTimer) { clearTimeout(S.renderTimer); S.renderTimer = null; }
    S.message = "";
  });

  it("releases the busy gate and says so when reporting the result throws", async () => {
    await hostWith(async () => hostileResult);
    openScreenWithOneAction();

    handleSettingsKey("enter");
    assert.strictEqual(S.busy, true, "the gate must be armed while the action runs");

    await vi.waitFor(() => assert.strictEqual(S.busy, false, "a dropped report leaves every later keystroke ignored"));
    assert.match(S.message, /could not be completed/, "the user must be told, got: " + S.message);
  });

  it("releases the busy gate and flashes the message on a result it can read", async () => {
    await hostWith(async () => ({ ok: true, message: "did it" }));
    openScreenWithOneAction();

    handleSettingsKey("enter");

    await vi.waitFor(() => assert.strictEqual(S.busy, false));
    assert.strictEqual(S.message, "did it");
  });
});

describe("settings tab", () => {
  it("lists a contributed section by its own label and names the plugin that added it", () => {
    seedSections();
    const { body } = render();

    const row = body.find((line) => line.includes("Sync") && line.includes("added by sync-bridge"));
    assert.ok(row, "expected an attributed Sync row, got:\n" + body.join("\n"));
    // What the section did not claim stays under the plugin's own name, unattributed.
    const own = body.find((line) => line.trim().startsWith("sync-bridge"));
    assert.ok(own && !own.includes("added by"), "expected an unattributed sync-bridge row");
  });

  it("shows a declared action as a runnable row inside the section it was contributed to", () => {
    seedSections();
    const section = S.settingsEntries.find((entry) => entry.type === "group" && entry.section.addedBy);
    S.configTarget = { name: section.section.label, plugin: section.section.plugin, bundle: section.section.bundle, file: section.section.file, addedBy: section.section.addedBy, sectionId: section.section.sectionId };
    S.configItems = section.section.items;
    S.cfgcursor = 0;
    S.mode = "pconfig";

    const { body } = render();

    assert.ok(body.some((line) => line.includes("added by sync-bridge")), "expected the editor to name the contributor");
    assert.ok(body.some((line) => line.includes("Sync now") && line.includes("↵ run")), "expected a runnable action row");
    assert.ok(body.some((line) => line.includes("enabled")), "expected the claimed setting");
    assert.ok(!body.some((line) => line.includes("logging")), "the unclaimed setting belongs to the plugin's own group");
  });
});
