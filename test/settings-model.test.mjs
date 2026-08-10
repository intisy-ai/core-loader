import { describe, it } from "vitest";
import assert from "node:assert";
import { buildSettingsEntries, firstSelectableIndex, buildGlobalSection, splitBySections } from "../dist/settings-model.js";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("settings-model", () => {
  it("buildSettingsEntries and firstSelectableIndex behave as expected", () => {
    const secs = [
      { label: "Global", kind: "global", file: "settings.json", bundle: null, items: [{ key: "a" }] },
      { label: "core-auth", kind: "plugin", file: "core-auth.json", bundle: "/x.js", items: [{ key: "b" }] },
      { label: "claude-code", kind: "plugin", file: "claude-code.json", bundle: "/y.js", items: [{ key: "c" }] },
    ];

    // Global header + 1 group, Plugins header + 2 groups = 5 entries
    const e1 = buildSettingsEntries(secs);
    assert.deepEqual(e1.map((e) => e.type), ["header", "group", "header", "group", "group"]);
    assert.equal(e1[0].label, "Global");
    assert.equal(e1[1].section.label, "Global");
    assert.equal(e1[2].label, "Plugins");
    assert.equal(e1[3].section.label, "core-auth");
    // first selectable skips the leading header
    assert.equal(firstSelectableIndex(e1), 1);
    assert.equal(firstSelectableIndex([{ type: "header", label: "x" }]), 0);

    // no plugins -> only the Global header + group
    const e2 = buildSettingsEntries([secs[0]]);
    assert.deepEqual(e2.map((e) => e.type), ["header", "group"]);

    // no globals (defensive) -> only the Plugins section
    const e3 = buildSettingsEntries([secs[1], secs[2]]);
    assert.deepEqual(e3.map((e) => e.type), ["header", "group", "group"]);
    assert.equal(e3[0].label, "Plugins");

    // loading placeholders: appended under the Plugins header; not selectable (nav skips them)
    const e4 = buildSettingsEntries([secs[0]], ["antigravity", "sync-bridge"]);
    assert.deepEqual(e4.map((e) => e.type), ["header", "group", "header", "loading", "loading"]);
    assert.equal(e4[3].label, "antigravity");
    assert.equal(firstSelectableIndex(e4), 1);   // the Global group, skipping headers + loading
    // only-loading (no probed plugins yet) still shows the Plugins header
    const e5 = buildSettingsEntries([secs[0]], ["x"]);
    assert.deepEqual(e5.map((e) => e.type), ["header", "group", "header", "loading"]);
  });
});

describe("splitBySections", () => {
  const cfg = () => ({
    name: "sync-bridge",
    bundle: "/plugins/sync-bridge.js",
    items: [
      { key: "logging", value: true, def: true, isSet: false, type: "boolean" },
      { key: "enabled", value: true, def: true, isSet: false, type: "boolean" },
      { key: "categories.accounts", value: false, def: true, isSet: true, type: "boolean" },
    ],
    actions: [{ id: "sync", label: "Sync now", description: "Reconcile now." }],
    sections: [{ id: "sync", label: "Sync", order: 40, fields: ["enabled", "categories.accounts"], actions: ["sync"] }],
  });

  it("puts the claimed settings and actions in the contributed section, attributed to the plugin", () => {
    const [section] = splitBySections(cfg());
    assert.equal(section.label, "Sync");
    assert.equal(section.addedBy, "sync-bridge");
    assert.equal(section.sectionId, "sync");
    assert.equal(section.file, "sync-bridge.json");
    assert.deepEqual(section.items.map((i) => i.key), ["enabled", "categories.accounts", "sync"]);
    assert.equal(section.items[2].kind, "action");
    assert.equal(section.items[2].label, "Sync now");
  });

  it("leaves the unclaimed settings as the plugin's own group, unattributed", () => {
    const own = splitBySections(cfg())[1];
    assert.equal(own.label, "sync-bridge");
    assert.equal(own.addedBy, undefined);
    assert.deepEqual(own.items.map((i) => i.key), ["logging"]);
  });

  it("yields one unattributed group when the plugin contributes no section", () => {
    const plain = { name: "wakatime-sync", bundle: "/w.js", items: [{ key: "apiKey", value: "", def: "", isSet: false, type: "string" }] };
    const sections = splitBySections(plain);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].label, "wakatime-sync");
    assert.equal(sections[0].addedBy, undefined);
  });

  it("drops a section whose members the plugin never declared", () => {
    const ghost = { name: "p", bundle: "/p.js", items: [], actions: [], sections: [{ id: "x", label: "X", fields: ["nope"] }] };
    assert.deepEqual(splitBySections(ghost), []);
  });

  it("lists contributed sections before plugin groups, ordered by their declared order", () => {
    const entries = buildSettingsEntries([
      { label: "Global", kind: "global", file: "settings.json", bundle: null, items: [{ key: "a" }] },
      { label: "wakatime-sync", kind: "plugin", file: "w.json", bundle: "/w.js", items: [{ key: "b" }] },
      { label: "Sync", kind: "plugin", file: "s.json", bundle: "/s.js", items: [{ key: "c" }], addedBy: "sync-bridge", order: 40 },
      { label: "Versioning", kind: "plugin", file: "v.json", bundle: "/v.js", items: [{ key: "d" }], addedBy: "config-ledger", order: 10 },
    ]);
    assert.deepEqual(
      entries.filter((e) => e.type === "group").map((e) => e.section.label),
      ["Global", "Versioning", "Sync", "wakatime-sync"],
    );
  });
});

describe("buildGlobalSection", () => {
  const require = createRequire(import.meta.url);
  const { S } = require("../dist/state.js");

  it("renders the settings the host injected, including a choice field", () => {
    S.capabilities = {
      globalSettings: {
        defaults: { activityMaxDays: 0, activityMinImpact: "info" },
        fields: [
          { key: "activityMaxDays", type: "number", label: "Keep at most (days)" },
          { key: "activityMinImpact", type: "select", options: [{ value: "info", label: "info" }, { value: "error", label: "error" }] },
        ],
      },
    };
    try {
      const items = buildGlobalSection().items;
      const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
      assert.ok(byKey.activityMaxDays, "expected the injected retention key");
      assert.deepEqual(byKey.activityMinImpact.options.map((o) => o.value), ["info", "error"]);
    } finally {
      S.capabilities = {};
    }
  });

  it("falls back to its own defaults when the host injects nothing", () => {
    S.capabilities = {};
    const keys = buildGlobalSection().items.map((i) => i.key);
    assert.ok(keys.includes("logConsole"), "expected the fallback keys: " + keys.join(","));
  });
});
