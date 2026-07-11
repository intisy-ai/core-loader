import assert from "node:assert";
import { annotateModified, buildSettingsEntries, firstSelectableIndex } from "../dist/settings-model.js";
import { diffKeyId } from "../dist/config-ledger.js";

const sections = [
  { label: "Global", kind: "global", file: "settings.json", bundle: null, items: [
    { key: "logConsole", value: false, def: false, isSet: false, type: "boolean" },
    { key: "logColor", value: true, def: true, isSet: false, type: "boolean" },
  ]},
  { label: "core-auth", kind: "plugin", file: "core-auth.json", bundle: "/x/core-auth.js", items: [
    { key: "leaderboard.enabled", value: true, def: false, isSet: true, type: "boolean" },
    { key: "leaderboard.apiKey", value: "x", def: "", isSet: true, type: "string" },
  ]},
];

// two changed keys, both in core-auth
const diffSet = new Set([
  diffKeyId("core-auth.json", "leaderboard.enabled"),
  diffKeyId("core-auth.json", "leaderboard.apiKey"),
]);
const out = annotateModified(sections, diffSet);

// returns the same array, mutated in place
assert.strictEqual(out, sections);
// Global has no modified keys; core-auth has 2
assert.equal(sections[0].modifiedCount, 0);
assert.equal(sections[1].modifiedCount, 2);

// empty diff set -> all zero
annotateModified(sections, new Set());
assert.equal(sections[0].modifiedCount, 0);
assert.equal(sections[1].modifiedCount, 0);

// partial: only one key in the set
annotateModified(sections, new Set([diffKeyId("core-auth.json", "leaderboard.apiKey")]));
assert.equal(sections[1].modifiedCount, 1);

// --- buildSettingsEntries: headers separate Global vs Plugins; install appended when installable ---
const secs = [
  { label: "Global", kind: "global", file: "settings.json", bundle: null, items: [] },
  { label: "core-auth", kind: "plugin", file: "core-auth.json", bundle: "/x.js", items: [] },
  { label: "claude-code", kind: "plugin", file: "claude-code.json", bundle: "/y.js", items: [] },
];

// installed (installable=false): Global header + 1 group, Plugins header + 2 groups = 5 entries, no install
const e1 = buildSettingsEntries(secs, false);
assert.deepEqual(e1.map((e) => e.type), ["header", "group", "header", "group", "group"]);
assert.equal(e1[0].label, "Global");
assert.equal(e1[2].label, "Plugins");
assert.equal(e1[1].section.label, "Global");
// first selectable skips the leading header
assert.equal(firstSelectableIndex(e1), 1);

// absent (installable=true): a single install prompt LEADS (no header), then the settings
const e2 = buildSettingsEntries(secs, true);
assert.deepEqual(e2.map((e) => e.type), ["install", "header", "group", "header", "group", "group"]);
assert.equal(e2[0].type, "install");
// the install prompt is the first selectable entry (default cursor lands on it)
assert.equal(firstSelectableIndex(e2), 0);

// no plugins -> no Plugins header
const e3 = buildSettingsEntries([secs[0]], false);
assert.deepEqual(e3.map((e) => e.type), ["header", "group"]);

console.log("settings-model.test.mjs OK");
