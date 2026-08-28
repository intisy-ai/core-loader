import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homePaths } from "./home-paths.js";
import type { MarketplaceSource } from "./catalog-sources.js";
import type { CatalogEntry } from "./capability-catalog.js";
import {
  CATALOG_CACHE_FILE,
  catalogFor,
  categoryOf,
  entriesFromMarketplaceManifest,
  entryFrom,
  invalidateCapabilityCatalog,
  isPluginCandidate,
  queryCapability,
  readCatalog,
} from "./capability-catalog.js";

const ORG: MarketplaceSource = { id: "demo-org", label: "demo-org", type: "github-org", enabled: true, org: "demo-org" };

const RESPONSES: Record<string, unknown> = {
  "https://api.github.com/orgs/demo-org/repos?per_page=100&page=1": [
    { name: "manager", html_url: "https://github.com/demo-org/manager", description: "Manages plugins", topics: ["plugin"], archived: false },
    { name: "retired", html_url: "https://github.com/demo-org/retired", description: "Old", topics: ["plugin"], archived: true },
    { name: "website", html_url: "https://github.com/demo-org/website", description: "Site", topics: ["marketing"], archived: false },
    { name: "untagged", html_url: "https://github.com/demo-org/untagged", description: "No topics", topics: [], archived: false },
  ],
  "https://raw.githubusercontent.com/demo-org/manager/HEAD/plugin.json": {
    id: "manager", api: 1, entry: "dist/index.js", displayName: "Manager", capabilities: ["plugin-management", "settings"],
  },
  "https://raw.githubusercontent.com/demo-org/manager/HEAD/package.json": { name: "@demo/manager" },
  "https://raw.githubusercontent.com/demo-org/untagged/HEAD/plugin.json": { id: "untagged", api: 1 },
  "https://raw.githubusercontent.com/demo-org/untagged/HEAD/package.json": { name: "untagged" },
};

function recordingFetch() {
  const seen: string[] = [];
  const fetchJson = async (url: string): Promise<unknown> => {
    seen.push(url);
    return Object.prototype.hasOwnProperty.call(RESPONSES, url) ? RESPONSES[url] : null;
  };
  return { seen, fetchJson };
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "core-loader-catalog-"));
}

describe("isPluginCandidate", () => {
  it("skips an archived repo and one whose topics name no category, and keeps one with no topics", () => {
    expect(isPluginCandidate({ topics: ["plugin"], archived: true })).toBe(false);
    expect(isPluginCandidate({ topics: ["marketing"], archived: false })).toBe(false);
    expect(isPluginCandidate({ topics: [], archived: false })).toBe(true);
    expect(isPluginCandidate({ topics: ["ai-provider"], archived: false })).toBe(true);
  });
});

describe("entryFrom", () => {
  it("takes the npm name from package.json and every declared capability from the manifest", () => {
    const entry = entryFrom(
      { id: "demo", api: 1, capabilities: ["screens", "settings"], displayName: "Demo" },
      "@scope/demo",
      { url: "https://github.com/o/demo.git", description: "d" },
      "src",
    );
    expect(entry).toEqual({
      id: "demo",
      npmName: "@scope/demo",
      url: "https://github.com/o/demo.git",
      capabilities: ["screens", "settings"],
      description: "d",
      displayName: "Demo",
      sourceId: "src",
    });
  });

  it("falls back to the id when no package name answers, and reads a library as zero capabilities", () => {
    const entry = entryFrom({ id: "lib", api: 1 }, null, { url: "u", description: "" }, "src");
    expect(entry?.npmName).toBe("lib");
    expect(entry?.capabilities).toEqual([]);
  });

  it("answers null for anything that declares no id", () => {
    expect(entryFrom({ api: 1 }, "n", { url: "u", description: "" }, "s")).toBeNull();
    expect(entryFrom(null, "n", { url: "u", description: "" }, "s")).toBeNull();
    expect(entryFrom("nope", "n", { url: "u", description: "" }, "s")).toBeNull();
  });
});

describe("readCatalog", () => {
  it("answers from each candidate's own manifest and never asks a filtered-out repo", async () => {
    const { seen, fetchJson } = recordingFetch();
    const entries = await readCatalog([ORG], { fetchJson });
    expect(entries.map((entry) => entry.id).sort()).toEqual(["manager", "untagged"]);
    expect(entries.find((entry) => entry.id === "manager")?.npmName).toBe("@demo/manager");
    expect(entries.find((entry) => entry.id === "manager")?.capabilities).toContain("plugin-management");
    expect(seen.some((url) => url.includes("/retired/"))).toBe(false);
    expect(seen.some((url) => url.includes("/website/"))).toBe(false);
  });

  it("a repo with no manifest contributes nothing rather than an empty entry", async () => {
    const { fetchJson } = recordingFetch();
    const entries = await readCatalog([{ ...ORG, id: "other" }], { fetchJson });
    expect(entries.every((entry) => entry.id !== "retired")).toBe(true);
  });

  it("reads a manifest source's listed repositories", async () => {
    const listing = {
      "https://example.test/catalog.json": { entries: [{ name: "manager", url: "https://github.com/demo-org/manager.git", description: "listed" }] },
    };
    const fetchJson = async (url: string): Promise<unknown> =>
      Object.prototype.hasOwnProperty.call(listing, url) ? (listing as Record<string, unknown>)[url]
        : Object.prototype.hasOwnProperty.call(RESPONSES, url) ? RESPONSES[url] : null;
    const entries = await readCatalog([{ id: "published", label: "p", type: "manifest", enabled: true, url: "https://example.test/catalog.json" }], { fetchJson });
    expect(entries.map((entry) => entry.id)).toEqual(["manager"]);
    expect(entries[0].sourceId).toBe("published");
    expect(entries[0].description).toBe("listed");
  });

  it("reads a local source's file and skips a disabled source entirely", async () => {
    const dir = mkdtempSync(join(tmpdir(), "core-loader-local-"));
    writeFileSync(join(dir, "marketplace.json"), JSON.stringify({ entries: [{ name: "manager", url: "https://github.com/demo-org/manager.git" }] }));
    const { seen, fetchJson } = recordingFetch();
    const entries = await readCatalog(
      [{ id: "here", label: "here", type: "local", enabled: true, path: dir }, { ...ORG, enabled: false }],
      { fetchJson },
    );
    expect(entries.map((entry) => entry.id)).toEqual(["manager"]);
    expect(seen.some((url) => url.includes("api.github.com"))).toBe(false);
  });

  it("one unreadable source costs the others nothing", async () => {
    const listing = { entries: [{ name: "manager", url: "https://github.com/demo-org/manager.git", description: "listed" }] };
    const failing = async (url: string): Promise<unknown> => {
      if (url.includes("api.github.com")) throw new Error("offline");
      if (url === "https://example.test/catalog.json") return listing;
      return Object.prototype.hasOwnProperty.call(RESPONSES, url) ? RESPONSES[url] : null;
    };
    const logged: string[] = [];
    const entries = await readCatalog(
      [ORG, { id: "published", label: "p", type: "manifest", enabled: true, url: "https://example.test/catalog.json" }],
      { fetchJson: failing, log: (message) => logged.push(message) },
    );
    expect(entries.map((entry) => entry.id)).toEqual(["manager"]);
    expect(entries[0].sourceId).toBe("published");
    expect(logged.some((line) => line.includes("demo-org"))).toBe(true);
  });

  it("bounds how many candidates one source is read at a time", async () => {
    const listed = Array.from({ length: 30 }, (_, index) => ({
      name: `repo-${index}`, html_url: `https://github.com/demo-org/repo-${index}`, description: "", topics: [], archived: false,
    }));
    let inFlight = 0;
    let peak = 0;
    const watching = async (url: string): Promise<unknown> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return url.includes("api.github.com") ? listed : null;
    };
    await readCatalog([ORG], { fetchJson: watching });
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });

  it("the first source to claim an id keeps it", async () => {
    const first = { entries: [{ name: "manager", url: "https://github.com/demo-org/manager.git", description: "first" }] };
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url === "https://example.test/a.json") return first;
      return Object.prototype.hasOwnProperty.call(RESPONSES, url) ? RESPONSES[url] : null;
    };
    const entries = await readCatalog(
      [{ id: "a", label: "a", type: "manifest", enabled: true, url: "https://example.test/a.json" }, ORG],
      { fetchJson },
    );
    expect(entries.filter((entry) => entry.id === "manager")).toHaveLength(1);
    expect(entries.find((entry) => entry.id === "manager")?.sourceId).toBe("a");
  });
});

describe("queryCapability", () => {
  it("answers only the entries providing the capability, and caches the whole catalog", async () => {
    const home = tempHome();
    const paths = homePaths(home);
    const { seen, fetchJson } = recordingFetch();
    const answered = await queryCapability("plugin-management", [ORG], paths, 3600000, { fetchJson, now: () => 1000 });
    expect(answered.map((entry) => entry.id)).toEqual(["manager"]);
    expect(existsSync(join(paths.cacheDir, CATALOG_CACHE_FILE))).toBe(true);
    const cached = JSON.parse(readFileSync(join(paths.cacheDir, CATALOG_CACHE_FILE), "utf8"));
    expect(cached.entries.map((entry: { id: string }) => entry.id).sort()).toEqual(["manager", "untagged"]);

    const before = seen.length;
    const again = await queryCapability("settings", [ORG], paths, 3600000, { fetchJson, now: () => 2000 });
    expect(again.map((entry) => entry.id)).toEqual(["manager"]);
    expect(seen.length).toBe(before);
  });

  it("caches an empty answer too, so a home with no provider does not re-read every launch", async () => {
    const home = tempHome();
    const paths = homePaths(home);
    const empty = async (): Promise<unknown> => null;
    let calls = 0;
    const counting = async (): Promise<unknown> => { calls++; return empty(); };
    expect(await queryCapability("plugin-management", [ORG], paths, 3600000, { fetchJson: counting, now: () => 1000 })).toEqual([]);
    const after = calls;
    expect(await queryCapability("plugin-management", [ORG], paths, 3600000, { fetchJson: counting, now: () => 1000 })).toEqual([]);
    expect(calls).toBe(after);
  });

  it("refetches once the window has passed, and after the cache is invalidated", async () => {
    const home = tempHome();
    const paths = homePaths(home);
    const { seen, fetchJson } = recordingFetch();
    await queryCapability("plugin-management", [ORG], paths, 1000, { fetchJson, now: () => 1000 });
    const first = seen.length;
    await queryCapability("plugin-management", [ORG], paths, 1000, { fetchJson, now: () => 5000 });
    expect(seen.length).toBeGreaterThan(first);
    const second = seen.length;
    invalidateCapabilityCatalog(paths);
    await queryCapability("plugin-management", [ORG], paths, 1000, { fetchJson, now: () => 5000 });
    expect(seen.length).toBeGreaterThan(second);
  });

  it("an unknown capability id is simply nobody's, never an error", async () => {
    const home = tempHome();
    const { fetchJson } = recordingFetch();
    expect(await queryCapability("time-travel", [ORG], homePaths(home), 3600000, { fetchJson })).toEqual([]);
  });
});

describe("catalogFor", () => {
  it("answers every entry, not just one capability's, and shares the cache with queryCapability", async () => {
    const home = tempHome();
    const paths = homePaths(home);
    const { seen, fetchJson } = recordingFetch();
    const all = await catalogFor([ORG], paths, 3600000, { fetchJson, now: () => 1000 });
    expect(all.map((entry) => entry.id).sort()).toEqual(["manager", "untagged"]);

    const before = seen.length;
    const queried = await queryCapability("plugin-management", [ORG], paths, 3600000, { fetchJson, now: () => 2000 });
    expect(queried.map((entry) => entry.id)).toEqual(["manager"]);
    expect(seen.length).toBe(before);
  });

  it("refetches once the window has passed", async () => {
    const home = tempHome();
    const paths = homePaths(home);
    const { seen, fetchJson } = recordingFetch();
    await catalogFor([ORG], paths, 1000, { fetchJson, now: () => 1000 });
    const first = seen.length;
    await catalogFor([ORG], paths, 1000, { fetchJson, now: () => 5000 });
    expect(seen.length).toBeGreaterThan(first);
  });
});

describe("categoryOf", () => {
  it("titles the first declared capability, and calls a library a library", () => {
    const entry = (capabilities: string[]) => ({
      id: "x", npmName: "x", url: "u", capabilities, description: "", sourceId: "s",
    });
    expect(categoryOf(entry(["provider", "screens"]))).toBe("Provider");
    expect(categoryOf(entry(["front-door"]))).toBe("Front-door");
    expect(categoryOf(entry(["plugin-management"]))).toBe("Plugin-management");
    expect(categoryOf(entry([]))).toBe("Library");
  });

  it("groups a capability this host has never heard of by its own name", () => {
    const entry = { id: "x", npmName: "x", url: "u", capabilities: ["time-travel"], description: "", sourceId: "s" };
    expect(categoryOf(entry)).toBe("Time-travel");
  });
});

describe("an owner that is a person, not an organisation", () => {
  const USER: MarketplaceSource = { id: "person", label: "person", type: "github-org", enabled: true, org: "person" };
  const REPOS = [{ name: "tool", html_url: "https://github.com/person/tool", description: "A tool", topics: [], archived: false }];

  function scopedFetch(answers: Record<string, unknown>) {
    const seen: string[] = [];
    const fetchJson = async (url: string): Promise<unknown> => {
      seen.push(url);
      return Object.prototype.hasOwnProperty.call(answers, url) ? answers[url] : null;
    };
    return { seen, fetchJson };
  }

  it("falls back to the user listing when the org listing answers nothing", async () => {
    const { seen, fetchJson } = scopedFetch({
      "https://api.github.com/users/person/repos?per_page=100&page=1": REPOS,
      "https://raw.githubusercontent.com/person/tool/HEAD/plugin.json": { id: "tool", api: 1 },
    });
    const entries = await readCatalog([USER], { fetchJson });
    expect(entries.map((entry) => entry.id)).toEqual(["tool"]);
    expect(seen).toContain("https://api.github.com/orgs/person/repos?per_page=100&page=1");
  });

  it("never asks the user listing when the org listing answered", async () => {
    const { seen, fetchJson } = scopedFetch({
      "https://api.github.com/orgs/person/repos?per_page=100&page=1": REPOS,
      "https://raw.githubusercontent.com/person/tool/HEAD/plugin.json": { id: "tool", api: 1 },
    });
    const entries = await readCatalog([USER], { fetchJson });
    expect(entries.map((entry) => entry.id)).toEqual(["tool"]);
    expect(seen.some((url) => url.includes("/users/"))).toBe(false);
  });

  it("pages within the scope that answered, never re-resolving it", async () => {
    const full = Array.from({ length: 100 }, (unused, index) => ({
      name: "repo-" + index, html_url: "https://github.com/person/repo-" + index, description: "", topics: ["plugin"], archived: false,
    }));
    const { seen, fetchJson } = scopedFetch({
      "https://api.github.com/users/person/repos?per_page=100&page=1": full,
      "https://api.github.com/users/person/repos?per_page=100&page=2": REPOS,
    });
    await readCatalog([USER], { fetchJson });
    expect(seen).toContain("https://api.github.com/users/person/repos?per_page=100&page=2");
    expect(seen.filter((url) => url.includes("/orgs/"))).toEqual([
      "https://api.github.com/orgs/person/repos?per_page=100&page=1",
    ]);
  });

  it("an owner neither listing knows costs nothing further", async () => {
    const { seen, fetchJson } = scopedFetch({});
    expect(await readCatalog([USER], { fetchJson })).toEqual([]);
    expect(seen).toHaveLength(2);
  });
});

describe("entriesFromMarketplaceManifest", () => {
  const candidate = { url: "https://github.com/person/market.git", description: "the repo" };

  it("offers one entry per listed plugin, with the repo's own url for a relative source", () => {
    const entries = entriesFromMarketplaceManifest(
      { plugins: [{ name: "one", source: "./plugin", description: "first" }, { name: "two", source: "./other" }] },
      candidate,
      "src",
    );
    expect(entries).toEqual([
      { id: "one", npmName: "one", url: candidate.url, capabilities: [], description: "first", category: "Plugin", sourceId: "src" },
      { id: "two", npmName: "two", url: candidate.url, capabilities: [], description: "the repo", category: "Plugin", sourceId: "src" },
    ]);
  });

  it("resolves a url source and an owner/repo source to their own clone url", () => {
    const entries = entriesFromMarketplaceManifest(
      {
        plugins: [
          { name: "byUrl", source: { source: "url", url: "https://github.com/other/thing.git" } },
          { name: "byRepo", source: { source: "github", repo: "other/named" } },
        ],
      },
      candidate,
      "src",
    );
    expect(entries.map((entry) => entry.url)).toEqual([
      "https://github.com/other/thing.git",
      "https://github.com/other/named.git",
    ]);
  });

  it("prefers the source's own curated category over the third-party default", () => {
    const entries = entriesFromMarketplaceManifest({ plugins: [{ name: "one" }] }, { ...candidate, category: "Memory" }, "src");
    expect(entries[0].category).toBe("Memory");
  });

  it("skips an item with no name and yields nothing for a file with no plugins", () => {
    expect(entriesFromMarketplaceManifest({ plugins: [{ description: "nameless" }, { name: "" }] }, candidate, "src")).toEqual([]);
    expect(entriesFromMarketplaceManifest({ name: "market" }, candidate, "src")).toEqual([]);
    expect(entriesFromMarketplaceManifest(null, candidate, "src")).toEqual([]);
    expect(entriesFromMarketplaceManifest("nope", candidate, "src")).toEqual([]);
  });
});

describe("a third-party repository a declared source offers", () => {
  const LISTING = "https://example.test/featured.json";
  const source: MarketplaceSource = { id: "featured", label: "featured", type: "manifest", enabled: true, url: LISTING };

  function thirdPartyFetch(answers: Record<string, unknown>) {
    const seen: string[] = [];
    const fetchJson = async (url: string): Promise<unknown> => {
      seen.push(url);
      return Object.prototype.hasOwnProperty.call(answers, url) ? answers[url] : null;
    };
    return { seen, fetchJson };
  }

  it("reads its marketplace file when it carries no plugin.json of ours", async () => {
    const { fetchJson } = thirdPartyFetch({
      [LISTING]: { entries: [{ url: "https://github.com/person/market.git", description: "listed", category: "Memory" }] },
      "https://raw.githubusercontent.com/person/market/HEAD/.claude-plugin/marketplace.json": {
        plugins: [{ name: "remembers", source: "./plugin", description: "keeps things" }],
      },
    });
    const entries = await readCatalog([source], { fetchJson });
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("remembers");
    expect(entries[0].description).toBe("keeps things");
    expect(categoryOf(entries[0])).toBe("Memory");
    expect(entries[0].sourceId).toBe("featured");
  });

  it("is described by its own plugin.json when it has one, and its marketplace file is never fetched", async () => {
    const { seen, fetchJson } = thirdPartyFetch({
      [LISTING]: { entries: [{ url: "https://github.com/person/market.git", description: "listed" }] },
      "https://raw.githubusercontent.com/person/market/HEAD/plugin.json": { id: "ours", api: 1, capabilities: ["screens"] },
      "https://raw.githubusercontent.com/person/market/HEAD/.claude-plugin/marketplace.json": { plugins: [{ name: "theirs" }] },
    });
    const entries = await readCatalog([source], { fetchJson });
    expect(entries.map((entry) => entry.id)).toEqual(["ours"]);
    expect(seen.some((url) => url.includes(".claude-plugin"))).toBe(false);
  });

  it("offers every plugin one repository carries", async () => {
    const { fetchJson } = thirdPartyFetch({
      [LISTING]: { entries: [{ url: "https://github.com/person/market.git" }] },
      "https://raw.githubusercontent.com/person/market/HEAD/.claude-plugin/marketplace.json": {
        plugins: [{ name: "first", source: "./a" }, { name: "second", source: "./b" }],
      },
    });
    const entries = await readCatalog([source], { fetchJson });
    expect(entries.map((entry) => entry.id)).toEqual(["first", "second"]);
    expect(entries.every((entry) => entry.url === "https://github.com/person/market.git")).toBe(true);
  });

  it("is offered by the catalog but never matched by a capability query, because it declares none", async () => {
    const paths = homePaths(tempHome());
    const { fetchJson } = thirdPartyFetch({
      [LISTING]: { entries: [{ url: "https://github.com/person/market.git" }] },
      "https://raw.githubusercontent.com/person/market/HEAD/.claude-plugin/marketplace.json": { plugins: [{ name: "remembers" }] },
    });
    const deps = { fetchJson, now: () => 1000 };
    expect((await catalogFor([source], paths, 3600000, deps)).map((entry) => entry.id)).toEqual(["remembers"]);
    expect(await queryCapability("provider", [source], paths, 3600000, deps)).toEqual([]);
  });
});

describe("categoryOf, with a declared category", () => {
  const entry = (extra: Partial<CatalogEntry>): CatalogEntry => ({
    id: "x", npmName: "x", url: "u", capabilities: [], description: "", sourceId: "s", ...extra,
  });

  it("prefers a declared category over one derived from a capability", () => {
    expect(categoryOf(entry({ capabilities: ["provider"], category: "Memory" }))).toBe("Memory");
  });

  it("ignores an empty declared category and falls back", () => {
    expect(categoryOf(entry({ capabilities: ["provider"], category: "" }))).toBe("Provider");
    expect(categoryOf(entry({}))).toBe("Library");
  });
});
