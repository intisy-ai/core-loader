import { describe, it } from "vitest";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readDeployedProviders } from "../dist/loader-runtime.js";

function makeReposDir() {
  return mkdtempSync(join(tmpdir(), "core-loader-providers-"));
}

function writeRepo(reposDir, repo, pkg, dynamicManifest) {
  const repoDir = join(reposDir, repo);
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "package.json"), JSON.stringify(pkg));
  if (dynamicManifest !== undefined) {
    writeFileSync(join(repoDir, ".dynamic-providers.json"), typeof dynamicManifest === "string" ? dynamicManifest : JSON.stringify(dynamicManifest));
  }
}

describe("readDeployedProviders: accountPool", () => {
  it("defaults accountPool to the provider name when the authProviders entry has none", () => {
    const reposDir = makeReposDir();
    writeRepo(reposDir, "stub-auth", {
      claudeHub: { authProviders: [{ name: "stub", handler: "dist/handler.js" }] },
    });

    const [entry] = readDeployedProviders(reposDir);
    assert.equal(entry.provider, "stub");
    assert.equal(entry.accountPool, "stub");
  });

  it("uses the declared accountPool when present, so providers can share one pool", () => {
    const reposDir = makeReposDir();
    writeRepo(reposDir, "antigravity-auth", {
      claudeHub: {
        authProviders: [
          { name: "antigravity", handler: "dist/antigravity.js", accountPool: "google" },
          { name: "gemini-cli", handler: "dist/gemini-cli.js", accountPool: "google" },
        ],
      },
    });

    const entries = readDeployedProviders(reposDir);
    assert.equal(entries.length, 2);
    assert.ok(entries.every((e) => e.accountPool === "google"));
  });
});

describe("readDeployedProviders: dynamic manifest", () => {
  it("merges .dynamic-providers.json entries alongside static authProviders", () => {
    const reposDir = makeReposDir();
    writeRepo(
      reposDir,
      "custom-auth",
      { claudeHub: { authProviders: [{ name: "static-one", handler: "dist/static.js" }] } },
      [{ name: "my-endpoint", handler: "dist/dynamic.js", accountPool: "my-endpoint-pool" }],
    );

    const entries = readDeployedProviders(reposDir);
    const byName = Object.fromEntries(entries.map((e) => [e.provider, e]));
    assert.equal(entries.length, 2);
    assert.ok(byName["static-one"]);
    assert.equal(byName["static-one"].accountPool, "static-one");
    assert.ok(byName["my-endpoint"]);
    assert.equal(byName["my-endpoint"].accountPool, "my-endpoint-pool");
    assert.equal(byName["my-endpoint"].handlerPath, join(reposDir, "custom-auth", "dist/dynamic.js"));
  });

  it("ignores a malformed .dynamic-providers.json without throwing", () => {
    const reposDir = makeReposDir();
    writeRepo(reposDir, "broken-manifest", { claudeHub: { authProviders: [{ name: "ok", handler: "dist/ok.js" }] } }, "{ not valid json");

    const entries = readDeployedProviders(reposDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].provider, "ok");
  });

  it("ignores a .dynamic-providers.json that isn't an array", () => {
    const reposDir = makeReposDir();
    writeRepo(reposDir, "wrong-shape", { claudeHub: { authProviders: [] } }, { name: "not-an-array" });

    assert.deepEqual(readDeployedProviders(reposDir), []);
  });
});

describe("readDeployedProviders: models", () => {
  it("carries a declared provider's models array through verbatim", () => {
    const reposDir = makeReposDir();
    writeRepo(reposDir, "stub-auth", {
      claudeHub: { authProviders: [{ name: "stub", handler: "dist/handler.js", models: ["stub-model-1", "stub-model-2"] }] },
    });

    const [entry] = readDeployedProviders(reposDir);
    assert.deepEqual(entry.models, ["stub-model-1", "stub-model-2"]);
  });

  it("defaults models to an empty array when a declared provider has none", () => {
    const reposDir = makeReposDir();
    writeRepo(reposDir, "stub-auth", {
      claudeHub: { authProviders: [{ name: "stub", handler: "dist/handler.js" }] },
    });

    const [entry] = readDeployedProviders(reposDir);
    assert.deepEqual(entry.models, []);
  });

  it("carries a dynamic provider's models array through verbatim", () => {
    const reposDir = makeReposDir();
    writeRepo(
      reposDir,
      "custom-auth",
      { claudeHub: { authProviders: [] } },
      [{ name: "my-endpoint", handler: "dist/dynamic.js", models: [{ id: "custom-model", name: "Custom Model" }] }],
    );

    const [entry] = readDeployedProviders(reposDir);
    assert.deepEqual(entry.models, [{ id: "custom-model", name: "Custom Model" }]);
  });

  it("defaults a dynamic provider's models to an empty array when absent", () => {
    const reposDir = makeReposDir();
    writeRepo(
      reposDir,
      "custom-auth",
      { claudeHub: { authProviders: [] } },
      [{ name: "my-endpoint", handler: "dist/dynamic.js" }],
    );

    const [entry] = readDeployedProviders(reposDir);
    assert.deepEqual(entry.models, []);
  });
});

describe("readDeployedProviders: no providers declared", () => {
  it("yields nothing for a repo with no authProviders and no dynamic manifest", () => {
    const reposDir = makeReposDir();
    writeRepo(reposDir, "plain-plugin", { name: "plain-plugin", version: "1.0.0" });

    assert.deepEqual(readDeployedProviders(reposDir), []);
  });

  it("yields nothing for a reposDir that doesn't exist", () => {
    assert.deepEqual(readDeployedProviders(join(tmpdir(), "core-loader-providers-does-not-exist")), []);
  });
});

describe("loadUpdater", () => {
  it("imports the deployed bundle of whichever plugin declares plugin-management", async () => {
    const { loadUpdater } = await import("../dist/loader-runtime.js");
    const home = mkdtempSync(join(tmpdir(), "core-loader-home-"));
    const pluginDir = join(home, "plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(pluginDir, "demo-manager.json"), JSON.stringify({ id: "demo-manager", api: 1, entry: "dist/index.js", capabilities: ["plugin-management"] }));
    writeFileSync(join(pluginDir, "demo-manager.js"), "export function earlyLaunch() {}\nexport function getPlugins() { return []; }\n");

    const manager = await loadUpdater(home);
    assert.equal(typeof manager.earlyLaunch, "function");
  });

  it("throws a reason that names the capability, not a plugin, when nothing answers", async () => {
    const { loadUpdater } = await import("../dist/loader-runtime.js");
    const home = mkdtempSync(join(tmpdir(), "core-loader-home-empty-"));
    await assert.rejects(() => loadUpdater(home), (error) => {
      assert.match(String(error.message), /plugin-management/);
      return true;
    });
  });
});

describe("runEarlyLaunchHooks", () => {
  it("logs and returns rather than throwing when no plugin manages plugins", async () => {
    const { runEarlyLaunchHooks } = await import("../dist/loader-runtime.js");
    const home = mkdtempSync(join(tmpdir(), "core-loader-home-none-"));
    const lines = [];
    await runEarlyLaunchHooks(home, (message) => lines.push(message));
    assert.ok(lines.some((line) => line.includes("plugin-management")), lines.join(" | "));
  });
});
