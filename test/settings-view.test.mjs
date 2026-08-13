// The Settings tab renders whatever a plugin declared: its contributed sections carry the
// plugin's name, and an action shows as a row you run rather than a value you edit.
import { describe, it, beforeEach, afterEach } from "vitest";
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
