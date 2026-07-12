import assert from "node:assert";
import { buildSettingsEntries, firstSelectableIndex } from "../dist/settings-model.js";

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

console.log("settings-model.test.mjs OK");
