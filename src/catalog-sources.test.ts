import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homePaths } from "./home-paths.js";
import {
  DEFAULT_MARKETPLACE_ORG,
  builtInSource,
  parseMarketplaceSources,
  readMarketplaceSources,
} from "./catalog-sources.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "core-loader-sources-"));
}

describe("parseMarketplaceSources", () => {
  it("a home that declares none gets the built-in org source", () => {
    expect(parseMarketplaceSources(undefined)).toEqual([builtInSource()]);
    expect(parseMarketplaceSources([])).toEqual([builtInSource()]);
    expect(builtInSource().org).toBe(DEFAULT_MARKETPLACE_ORG);
  });

  it("keeps a declared source of each type, defaulting its label to its id", () => {
    const parsed = parseMarketplaceSources([
      { id: "org", type: "github-org", org: "some-org" },
      { id: "published", label: "Published", type: "manifest", url: "https://example.test/c.json" },
      { id: "here", type: "local", path: "/tmp/here" },
    ]);
    expect(parsed.map((source) => source.id)).toEqual(["org", "published", "here"]);
    expect(parsed[0].label).toBe("org");
    expect(parsed[1].label).toBe("Published");
    expect(parsed.every((source) => source.enabled === true)).toBe(true);
  });

  it("drops a source with no id, an unknown type, or no location for its type, keeping the rest", () => {
    const parsed = parseMarketplaceSources([
      { type: "github-org", org: "no-id" },
      { id: "future", type: "carrier-pigeon", url: "https://example.test" },
      { id: "half", type: "github-org" },
      { id: "kept", type: "github-org", org: "some-org" },
    ]);
    expect(parsed.map((source) => source.id)).toEqual(["kept"]);
  });

  it("keeps a disabled source, so a caller can report it rather than lose it", () => {
    const parsed = parseMarketplaceSources([{ id: "off", type: "github-org", org: "o", enabled: false }]);
    expect(parsed[0].enabled).toBe(false);
  });
});

describe("readMarketplaceSources", () => {
  it("reads config/marketplaces.json", () => {
    const home = tempHome();
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "marketplaces.json"), JSON.stringify({ sources: [{ id: "mine", type: "github-org", org: "mine" }] }));
    expect(readMarketplaceSources(homePaths(home)).map((s) => s.id)).toEqual(["mine"]);
  });

  it("prefers config/marketplaces.json over the top-level file", () => {
    const home = tempHome();
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "marketplaces.json"), JSON.stringify({ sources: [{ id: "preferred", type: "github-org", org: "a" }] }));
    writeFileSync(join(home, "marketplaces.json"), JSON.stringify({ sources: [{ id: "fallback", type: "github-org", org: "b" }] }));
    expect(readMarketplaceSources(homePaths(home)).map((s) => s.id)).toEqual(["preferred"]);
  });

  it("falls back to the built-in source for a home with no file and for an unreadable one", () => {
    const home = tempHome();
    expect(readMarketplaceSources(homePaths(home))).toEqual([builtInSource()]);
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "marketplaces.json"), "{ not json");
    expect(readMarketplaceSources(homePaths(home))).toEqual([builtInSource()]);
  });
});
