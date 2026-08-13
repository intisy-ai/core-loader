// Level 1 shows one row per DECLARED source, labelled by the source itself, counted from the entries
// that source offered. A home that declares three marketplaces gets three rows with no code change.
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { sourceRowsFrom } = require("../dist/marketplace.js");
const { S } = require("../dist/state.js");

function entry(id, sourceId, capabilities) {
  return { id: id, npmName: id, url: "https://github.com/o/" + id + ".git", capabilities: capabilities, description: id + " desc", sourceId: sourceId };
}

beforeEach(() => { S.sourceCatalog = []; S.sourceFetched = false; });

describe("sourceRowsFrom", () => {
  it("makes one row per source, labelled and counted from what that source offered", () => {
    const sources = [
      { id: "org-a", label: "Org A", type: "github-org", enabled: true, org: "org-a" },
      { id: "published", label: "Published", type: "manifest", enabled: true, url: "https://example.test/c.json" },
    ];
    const entries = [entry("one", "org-a", ["provider"]), entry("two", "org-a", []), entry("three", "published", ["screens"])];
    const rows = sourceRowsFrom(sources, entries);
    assert.deepEqual(rows.map((row) => row.name), ["Org A", "Published"]);
    assert.deepEqual(rows.map((row) => row.count), [2, 1]);
    assert.deepEqual(rows.map((row) => row.sourceId), ["org-a", "published"]);
    assert.ok(rows.every((row) => row.builtin === "source"));
  });

  it("describes each source by where it reads from, so two rows are told apart", () => {
    const rows = sourceRowsFrom([
      { id: "org-a", label: "Org A", type: "github-org", enabled: true, org: "org-a" },
      { id: "published", label: "Published", type: "manifest", enabled: true, url: "https://example.test/c.json" },
      { id: "here", label: "Here", type: "local", enabled: true, path: "/tmp/here" },
    ], []);
    assert.ok(rows[0].source.includes("org-a"));
    assert.ok(rows[1].source.includes("example.test"));
    assert.ok(rows[2].source.includes("/tmp/here"));
  });

  it("counts nothing as undefined until the fetch resolves, and skips a disabled source", () => {
    const sources = [
      { id: "org-a", label: "Org A", type: "github-org", enabled: true, org: "org-a" },
      { id: "off", label: "Off", type: "github-org", enabled: false, org: "off" },
    ];
    const rows = sourceRowsFrom(sources, null);
    assert.deepEqual(rows.map((row) => row.name), ["Org A"]);
    assert.equal(rows[0].count, undefined);
  });
});
