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

// Every guard is set here, not per case: a list build kicks its fetches, and a filtered run must
// reach the network no more than a whole run does.
beforeEach(() => {
  S.sourceCatalog = [];
  S.sourceFetched = true;
  S.catalogFetched = true;
  S.seedFetched = true;
});

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

const { buildMarketplaceMarketsList } = require("../dist/marketplace.js");

describe("Level 1", () => {
  it("names the declared sources, keeps community and Featured, and names no org itself", () => {
    S.sourceCatalog = [entry("one", "intisy-ai", ["provider"])];
    S.inputBuf = "";
    S.capabilities = {};
    const rows = buildMarketplaceMarketsList();
    const names = rows.filter((row) => !row.isAction).map((row) => row.name);
    assert.ok(names.includes("community"), names.join(","));
    assert.ok(names.includes("Featured"), names.join(","));
    assert.ok(!names.includes("intisy-ai (official)"), names.join(","));
    const sourceRow = rows.find((row) => row.builtin === "source");
    assert.ok(sourceRow, "a declared source must have a row: " + names.join(","));
    assert.equal(typeof sourceRow.sourceId, "string");
  });
});

const { buildMarketplacePluginsList } = require("../dist/marketplace.js");

describe("Level 2 for a declared source", () => {
  it("lists only that source's entries, grouped by the category each entry's capabilities imply", () => {
    S.sourceCatalog = [
      entry("a-provider", "org-a", ["provider"]),
      entry("z-library", "org-a", []),
      entry("m-screens", "org-a", ["screens", "settings"]),
      entry("elsewhere", "published", ["provider"]),
    ];
    S.inputBuf = "";
    const rows = buildMarketplacePluginsList("Org A", "source", "org-a");
    // category first, then name: Library(z-library), Provider(a-provider), Screens(m-screens)
    assert.deepEqual(rows.map((row) => row.name), ["z-library", "a-provider", "m-screens"]);
    assert.deepEqual(rows.map((row) => row.category), ["Library", "Provider", "Screens"]);
    assert.ok(!rows.some((row) => row.name === "elsewhere"), "another source's entry must not appear");
    // sections must be contiguous: the renderer emits a heading on every category change, so the
    // number of distinct categories must equal the number of times the category changes
    const categories = rows.map((row) => row.category);
    const changes = categories.filter((value, index) => index === 0 || categories[index - 1] !== value).length;
    assert.equal(new Set(categories).size, changes);
  });

  it("carries a url and a repo name so the install path works unchanged", () => {
    S.sourceCatalog = [entry("a-provider", "org-a", ["provider"])];
    S.inputBuf = "";
    const rows = buildMarketplacePluginsList("Org A", "source", "org-a");
    assert.equal(rows[0].url, "https://github.com/o/a-provider.git");
    assert.equal(rows[0].repoName, "a-provider");
  });

  it("answers an empty list, never throws, before the read resolves", () => {
    S.sourceCatalog = null;
    S.inputBuf = "";
    assert.deepEqual(buildMarketplacePluginsList("Org A", "source", "org-a"), []);
  });
});
