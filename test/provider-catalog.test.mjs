import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelCatalog, deployedProviders, modelEntries, providerRows } from "../dist/provider-catalog.js";

let home;
let reposDir;
let configDir;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cl-catalog-"));
  reposDir = join(home, "repos");
  configDir = join(home, "cfg");
  mkdirSync(reposDir, { recursive: true });
  mkdirSync(join(configDir, "config"), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function seedPlugin(repo, authProviders) {
  const dir = join(reposDir, repo);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "handler.js"), "");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ claudeHub: { authProviders } }));
}

function seedCatalog(catalog, file = "models.json") {
  writeFileSync(join(configDir, "config", file), JSON.stringify(catalog));
}

function seedRaw(text, file = "models.json") {
  writeFileSync(join(configDir, "config", file), text);
}

describe("readModelCatalog", () => {
  it("reads the catalog the account library wrote", () => {
    seedCatalog({ stub: { models: { a: { name: "A" } } } });
    assert.deepEqual(Object.keys(readModelCatalog(configDir)), ["stub"]);
  });

  // A home that has not refreshed since the rename still has its catalog under the old name.
  it("falls back to the pre-rename file", () => {
    seedCatalog({ stub: { models: { a: {} } } }, "core-auth-models.json");
    assert.deepEqual(Object.keys(readModelCatalog(configDir)), ["stub"]);
  });

  it("treats a missing, unparseable or wrongly shaped catalog as empty", () => {
    assert.deepEqual(readModelCatalog(configDir), {});
    seedRaw("{ not json");
    assert.deepEqual(readModelCatalog(configDir), {});
    // Valid JSON that is not a map of providers is as useless as none, and passing it on
    // would make every caller guess at the shape.
    seedRaw('["stub"]');
    assert.deepEqual(readModelCatalog(configDir), {});
  });
});

describe("deployedProviders", () => {
  it("lists every provider a plugin declares, not just one per plugin", () => {
    seedPlugin("multi-auth", [{ name: "metered", handler: "dist/handler.js" }, { name: "free", handler: "dist/handler.js" }]);
    assert.deepEqual(deployedProviders(reposDir).map((p) => p.provider), ["metered", "free"]);
  });

  it("reports a provider once even when two plugins declare it", () => {
    seedPlugin("a-auth", [{ name: "shared", handler: "dist/handler.js" }]);
    seedPlugin("b-auth", [{ name: "shared", handler: "dist/handler.js" }]);
    assert.deepEqual(deployedProviders(reposDir).map((p) => p.provider), ["shared"]);
  });
});

describe("modelEntries", () => {
  it("prefers the cached catalog and carries its scores", () => {
    seedPlugin("x-auth", [{ name: "x", handler: "dist/handler.js", models: ["stale"] }]);
    seedCatalog({ x: { models: { fresh: { name: "Fresh" } }, scores: { fresh: 7 }, scoreSource: "leaderboard" } });
    assert.deepEqual(modelEntries(reposDir, configDir), [
      { provider: "x", model: "fresh", name: "Fresh", id: "x/fresh", score: 7, scoreSource: "leaderboard" },
    ]);
  });

  it("falls back to a static list for a provider that fetches nothing", () => {
    seedPlugin("x-auth", [{ name: "x", handler: "dist/handler.js", models: [{ id: "m1", name: "Model One" }] }]);
    assert.deepEqual(modelEntries(reposDir, configDir), [{ provider: "x", model: "m1", name: "Model One", id: "x/m1" }]);
  });
});

describe("providerRows", () => {
  // The fault this replaces: two lanes of one plugin, and the count of one landing on the other.
  it("counts each provider's own models, never another's", () => {
    seedPlugin("multi-auth", [{ name: "metered", handler: "dist/handler.js" }, { name: "free", handler: "dist/handler.js" }]);
    seedCatalog({
      metered: { models: { "metered-a": {}, "metered-b": {} } },
      free: { models: { "free-a": {} } },
    });
    assert.deepEqual(providerRows(reposDir, configDir).map((r) => [r.id, r.count]), [["metered", 2], ["free", 1]]);
  });

  // antigravity has no catalog until someone logs in; hiding it would leave no way to log in.
  it("lists a provider with no models yet, still selectable", () => {
    seedPlugin("x-auth", [{ name: "x", handler: "dist/handler.js" }]);
    const rows = providerRows(reposDir, configDir);
    assert.deepEqual(rows.map((r) => [r.id, r.count]), [["x", 0]]);
    assert.ok(rows[0].handler.endsWith("handler.js"));
  });

  // A catalog left behind by a removed plugin should show, not vanish with it.
  it("lists a cached provider whose plugin is gone, with no handler", () => {
    seedCatalog({ ghost: { models: { a: {}, b: {} } } });
    assert.deepEqual(providerRows(reposDir, configDir), [{ id: "ghost", handler: null, count: 2 }]);
  });

  it("reports nothing for an empty home", () => {
    assert.deepEqual(providerRows(reposDir, configDir), []);
  });
});
