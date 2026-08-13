import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homePaths } from "./home-paths.js";
import type { MarketplaceSource } from "./catalog-sources.js";
import {
  CATALOG_CACHE_FILE,
  catalogFor,
  categoryOf,
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
