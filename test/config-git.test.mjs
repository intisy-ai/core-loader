import assert from "node:assert";
import { diffKeyId, buildDiffSet, resolveConfigGitLib } from "../dist/config-git.js";

// diffKeyId joins file+key with a NUL separator (collision-proof)
const SEP = String.fromCharCode(0);
assert.equal(diffKeyId("core-auth.json", "leaderboard.enabled"), "core-auth.json" + SEP + "leaderboard.enabled");

// buildDiffSet turns diff rows into an O(1) membership set keyed by file+key
const set = buildDiffSet([
  { file: "settings.json", key: "logConsole", old: "false", new: "true" },
  { file: "core-auth.json", key: "leaderboard.enabled", old: "true", new: "false" },
]);
assert.equal(set.has(diffKeyId("settings.json", "logConsole")), true);
assert.equal(set.has(diffKeyId("core-auth.json", "leaderboard.enabled")), true);
assert.equal(set.has(diffKeyId("settings.json", "logColor")), false);
assert.equal(buildDiffSet([]).size, 0);

// resolveConfigGitLib returns a string|null and never throws
const r = resolveConfigGitLib();
assert.ok(r === null || typeof r === "string");

console.log("config-git.test.mjs OK");
