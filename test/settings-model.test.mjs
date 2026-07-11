import assert from "node:assert";
import { flattenRows, firstItemIndex } from "../dist/settings-model.js";
import { diffKeyId } from "../dist/config-ledger.js";

const sections = [
  { label: "Global", kind: "global", file: "settings.json", bundle: null, items: [
    { key: "logConsole", value: false, def: false, isSet: false, type: "boolean" },
    { key: "logColor", value: true, def: true, isSet: false, type: "boolean" },
  ]},
  { label: "core-auth", kind: "plugin", file: "core-auth.json", bundle: "/x/core-auth.js", items: [
    { key: "leaderboard.enabled", value: true, def: false, isSet: true, type: "boolean" },
  ]},
];
const diffSet = new Set([diffKeyId("core-auth.json", "leaderboard.enabled")]);
const rows = flattenRows(sections, diffSet);

// header, 2 items, header, 1 item = 5 rows
assert.equal(rows.length, 5);
assert.equal(rows[0].type, "header");
assert.equal(rows[0].label, "Global");
assert.equal(rows[1].type, "item");
assert.equal(rows[1].file, "settings.json");
assert.equal(rows[1].modified, false);
assert.equal(rows[3].type, "header");
assert.equal(rows[3].label, "core-auth");
assert.equal(rows[4].type, "item");
assert.equal(rows[4].modified, true);          // in the diff set
assert.equal(rows[4].bundle, "/x/core-auth.js");

// first item row is index 1 (index 0 is a header)
assert.equal(firstItemIndex(rows), 1);
// all-headers -> 0
assert.equal(firstItemIndex([{ type: "header", label: "x", sectionIndex: 0, modified: false }]), 0);

console.log("settings-model.test.mjs OK");
