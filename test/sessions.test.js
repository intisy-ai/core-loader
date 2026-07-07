const test = require("node:test");
const assert = require("node:assert");
const { groupSessions } = require("../dist/projects.js");

const DIR = "/home/u/proj";
const OTHER = "/home/u/other";
const entries = [
  { project: DIR,   sessionId: "s1", display: "first prompt of s1",  timestamp: 100 },
  { project: DIR,   sessionId: "s1", display: "later prompt of s1",  timestamp: 300 },
  { project: DIR,   sessionId: "s2", display: "only prompt of s2",   timestamp: 200 },
  { project: OTHER, sessionId: "s3", display: "belongs to other",    timestamp: 999 },
  { project: DIR,   sessionId: "s4", timestamp: 50 }, // no display
];

test("groups by sessionId for the given dir only", () => {
  const out = groupSessions(entries, DIR);
  assert.deepStrictEqual(out.map((s) => s.id), ["s1", "s2", "s4"]); // by lastUsed desc: 300,200,50
});

test("title is the session's earliest prompt", () => {
  const out = groupSessions(entries, DIR);
  const s1 = out.find((s) => s.id === "s1");
  assert.strictEqual(s1.title, "first prompt of s1");
});

test("lastUsed is the max timestamp; count is entries in the group", () => {
  const out = groupSessions(entries, DIR);
  const s1 = out.find((s) => s.id === "s1");
  assert.strictEqual(s1.lastUsed, 300);
  assert.strictEqual(s1.count, 2);
});

test("a session with no prompt gets a placeholder title", () => {
  const out = groupSessions(entries, DIR);
  const s4 = out.find((s) => s.id === "s4");
  assert.strictEqual(s4.title, "(no prompt)");
});

test("entries from other projects are excluded", () => {
  const out = groupSessions(entries, DIR);
  assert.ok(!out.some((s) => s.id === "s3"));
});
