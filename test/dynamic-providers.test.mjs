import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeployedProviders } from "../dist/loader-runtime.js";

let home;
let repos;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "core-loader-dynamic-"));
  repos = join(home, "repos");
  mkdirSync(repos, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeHomeManifest(contents) {
  const cache = join(home, "cache");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "dynamic-providers.json"), JSON.stringify(contents), "utf8");
}

describe("readDeployedProviders: the home's dynamic providers", () => {
  it("returns one entry per lane the home declares", () => {
    mkdirSync(join(repos, "endpoints"), { recursive: true });
    writeFileSync(join(repos, "endpoints", "package.json"), JSON.stringify({ name: "endpoints" }), "utf8");
    writeHomeManifest({
      endpoints: [
        { name: "my-endpoint", repo: "endpoints", handler: "dist/handler.js", translator: "custom", accountPool: "my-endpoint" },
      ],
    });
    const out = readDeployedProviders(repos, home);
    assert.equal(out.length, 1);
    assert.equal(out[0].provider, "my-endpoint");
    assert.equal(out[0].repo, "endpoints");
    assert.equal(out[0].handlerPath, join(repos, "endpoints", "dist", "handler.js"));
    assert.equal(out[0].translator, "custom");
    assert.equal(out[0].accountPool, "my-endpoint");
  });

  it("defaults the account pool to the lane's own name", () => {
    writeHomeManifest({ endpoints: [{ name: "solo", repo: "endpoints", handler: "dist/handler.js" }] });
    assert.equal(readDeployedProviders(repos, home)[0].accountPool, "solo");
  });

  it("derives the home from the repos directory when none is given", () => {
    writeHomeManifest({ endpoints: [{ name: "derived", repo: "endpoints", handler: "dist/handler.js" }] });
    assert.equal(readDeployedProviders(repos)[0].provider, "derived");
  });

  it("skips a lane that names no provider or no handler", () => {
    writeHomeManifest({ endpoints: [{ repo: "endpoints", handler: "dist/handler.js" }, { name: "x", repo: "endpoints" }] });
    assert.deepEqual(readDeployedProviders(repos, home), []);
  });

  it("falls back to the declaring plugin id when a lane names no repo", () => {
    writeHomeManifest({ endpoints: [{ name: "x", handler: "dist/handler.js" }] });
    assert.equal(readDeployedProviders(repos, home)[0].handlerPath, join(repos, "endpoints", "dist", "handler.js"));
  });

  it("yields nothing for an absent, malformed or non-object manifest", () => {
    assert.deepEqual(readDeployedProviders(repos, home), []);
    const cache = join(home, "cache");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "dynamic-providers.json"), "{not json", "utf8");
    assert.deepEqual(readDeployedProviders(repos, home), []);
    writeFileSync(join(cache, "dynamic-providers.json"), "[]", "utf8");
    assert.deepEqual(readDeployedProviders(repos, home), []);
  });

  it("ignores a checkout's own .dynamic-providers.json", () => {
    mkdirSync(join(repos, "endpoints"), { recursive: true });
    writeFileSync(join(repos, "endpoints", "package.json"), JSON.stringify({ name: "endpoints" }), "utf8");
    writeFileSync(
      join(repos, "endpoints", ".dynamic-providers.json"),
      JSON.stringify([{ name: "stale", handler: "dist/handler.js" }]),
      "utf8",
    );
    assert.deepEqual(readDeployedProviders(repos, home), []);
  });

  it("still returns the providers a package.json declares, alongside the home's lanes", () => {
    mkdirSync(join(repos, "declared"), { recursive: true });
    writeFileSync(
      join(repos, "declared", "package.json"),
      JSON.stringify({ claudeHub: { authProviders: [{ name: "static", handler: "dist/handler.js" }] } }),
      "utf8",
    );
    writeHomeManifest({ endpoints: [{ name: "dynamic", repo: "declared", handler: "dist/handler.js" }] });
    assert.deepEqual(readDeployedProviders(repos, home).map((entry) => entry.provider).sort(), ["dynamic", "static"]);
  });
});
