import { afterEach, beforeEach, describe, it, vi } from "vitest";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { getMcpActions } from "../dist/mcp.js";

const DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const nodeRequire = createRequire(import.meta.url);
function bustDistRequireCache() {
  for (const key of Object.keys(nodeRequire.cache)) {
    if (key.startsWith(DIST_DIR)) delete nodeRequire.cache[key];
  }
}

describe("mcp: getMcpActions", () => {
  it("offers uninstall for an installed server, install otherwise, always ending in cancel", () => {
    assert.deepEqual(getMcpActions({ installed: true, env: {}, args: [] }).map((a) => a.key), ["uninstall", "cancel"]);
    assert.deepEqual(getMcpActions({ installed: false, env: {}, args: [] }).map((a) => a.key), ["install", "cancel"]);
  });

  it("adds a configure action when the server declares env keys", () => {
    const acts = getMcpActions({ installed: true, env: { API_KEY: "" }, args: [] });
    assert.deepEqual(acts.map((a) => a.key), ["uninstall", "configure", "cancel"]);
  });

  it("adds a browser action when an arg looks like an npm package (has @ and isn't -y)", () => {
    const acts = getMcpActions({ installed: true, env: {}, args: ["-y", "@scope/pkg"] });
    assert.deepEqual(acts.map((a) => a.key), ["uninstall", "browser", "cancel"]);
  });

  it("combines configure + browser when both conditions hold", () => {
    const acts = getMcpActions({ installed: false, env: { TOKEN: "" }, args: ["-y", "some-pkg@1.0"] });
    assert.deepEqual(acts.map((a) => a.key), ["install", "configure", "browser", "cancel"]);
  });
});

describe("mcp: scanPluginEmbeddedMcps walks every registered home", () => {
  let firstHome;
  let secondHome;
  const saved = {};
  const KEYS = ["HUB_APPS_FILE", "HUB_CONFIG_DIR", "HUB_APP_ID"];

  beforeEach(() => {
    firstHome = mkdtempSync(join(tmpdir(), "core-loader-mcp-first-"));
    secondHome = mkdtempSync(join(tmpdir(), "core-loader-mcp-second-"));
    for (const key of KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
    const appsFile = join(secondHome, "apps.json");
    writeFileSync(appsFile, JSON.stringify({
      alpha: { id: "alpha", label: "Alpha", home: { candidates: [firstHome] } },
      beta: { id: "beta", label: "Beta", home: { candidates: [secondHome] } },
    }));
    process.env.HUB_APPS_FILE = appsFile;
    const serverDir = join(secondHome, "repos", "acme", "widget-plugin");
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(serverDir, ".mcp.json"), JSON.stringify({
      mcpServers: { myserver: { command: "node", args: ["server.js"] } },
    }));
    bustDistRequireCache();
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    try { rmSync(firstHome, { recursive: true, force: true }); } catch {}
    try { rmSync(secondHome, { recursive: true, force: true }); } catch {}
  });

  it("finds a server planted under the second registered app's clones directory", async () => {
    const { scanPluginEmbeddedMcps } = await import("../dist/mcp.js");
    const embedded = scanPluginEmbeddedMcps();
    assert.ok(embedded["plugin:widget-plugin:myserver"]);
    assert.equal(embedded["plugin:widget-plugin:myserver"].command, "node");
  });
});
