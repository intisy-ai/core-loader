import assert from "node:assert";
import { annotateModified } from "../dist/settings-model.js";
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

console.log("settings-model.test.mjs OK");
