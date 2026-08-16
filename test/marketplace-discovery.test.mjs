// fetchCatalogsAsync's own compiled require() of child_process, app-descriptor.js and state.js
// all resolve through Node's native require cache, which vi.resetModules() does not clear (see
// npm-plugins.test.mjs / loader-config.test.mjs), so a stale app-descriptor.js (with its cached
// activeDescriptor) or a stale S (with catalogFetched already true) survives from an earlier test
// unless the whole dist/ subtree is purged here too.
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const nodeRequire = createRequire(import.meta.url);

function bustDistRequireCache() {
  for (const key of Object.keys(nodeRequire.cache)) {
    if (key.startsWith(DIST_DIR)) delete nodeRequire.cache[key];
  }
}

let dir;
const saved = {};
const KEYS = ["HUB_APPS_FILE", "HUB_CONFIG_DIR", "HUB_APP_ID"];

// child_process is a Node builtin, never a dist/ path, so bustDistRequireCache never touches it: the
// SAME module object survives every loadMarketplace() call in this file, real exec included. Capturing
// it exactly once (not inside loadMarketplace) keeps a test that calls loadMarketplace() twice from
// saving its own stub as "the real one" and leaking a permanently-stubbed exec into later tests.
const cp = nodeRequire("child_process");
const REAL_EXEC = cp.exec;

function registry(discovery) {
  writeFileSync(join(dir, "apps.json"), JSON.stringify({
    zeta: { id: "zeta", label: "Zeta", home: { candidates: [dir] }, ...(discovery ? { discovery } : {}) },
  }));
}

// fetchCatalogsAsync issues every network read through `exec`, never awaited by this test. Replacing
// child_process's own exec with a capturing stub (before the dist modules that destructure/reference
// it are required) means every call site fires synchronously enough to be captured, but no curl
// process is ever actually spawned, so this stays off the real network entirely.
function loadMarketplace() {
  bustDistRequireCache();
  const execCalls = [];
  cp.exec = function (cmd) {
    execCalls.push(cmd);
  };
  const marketplace = nodeRequire("../dist/marketplace.js");
  const { S } = nodeRequire("../dist/state.js");
  const { FEATURED_PLUGINS } = nodeRequire("../dist/env.js");
  return { marketplace, S, FEATURED_PLUGINS, execCalls };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "core-loader-marketplace-disc-"));
  for (const key of KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.HUB_APPS_FILE = join(dir, "apps.json");
  process.env.HUB_CONFIG_DIR = dir;
  process.env.HUB_APP_ID = "zeta";
});

afterEach(() => {
  cp.exec = REAL_EXEC;
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("marketplace discovery: an app's declared traits decide where its catalog looks", () => {
  it("an app declaring no awesomeList gets the built-in verified list seeded as Curated", () => {
    registry({});
    const { marketplace, S, FEATURED_PLUGINS } = loadMarketplace();

    marketplace.fetchCatalogsAsync();

    assert.strictEqual(S.MARKETPLACE_CATALOG.length, FEATURED_PLUGINS.length);
    assert.ok(S.MARKETPLACE_CATALOG.every((entry) => entry.category === "Curated"));
    assert.deepEqual(
      S.MARKETPLACE_CATALOG.map((entry) => entry.full_name).sort(),
      FEATURED_PLUGINS.map((entry) => entry.full_name).sort(),
    );
  });

  it("an app declaring an awesomeList does not get the built-in list seeded, and fetches its own", () => {
    const declaredUrl = "https://raw.githubusercontent.com/zeta-org/awesome-zeta/main/README.md";
    registry({ awesomeList: declaredUrl });
    const { marketplace, S, execCalls } = loadMarketplace();

    marketplace.fetchCatalogsAsync();

    assert.strictEqual(S.MARKETPLACE_CATALOG.length, 0, "no FEATURED_PLUGINS entries should be seeded");
    assert.ok(execCalls.some((cmd) => cmd.includes(declaredUrl)), "the declared awesome list must be fetched");
    assert.ok(execCalls.every((cmd) => !cmd.includes("awesome-opencode")), "no hardcoded awesome list may run");
  });

  it("an app declaring no topic issues no topic search, and one declaring a topic searches it", () => {
    registry({});
    const noTopic = loadMarketplace();
    noTopic.marketplace.fetchCatalogsAsync();
    const topicSearches = noTopic.execCalls.filter((cmd) => cmd.includes("q=topic:"));
    assert.ok(
      topicSearches.every((cmd) => cmd.includes("mcp-server")),
      "an app with no declared topic must issue no topic search of its own, only the unconditional mcp-server one",
    );

    registry({ topic: "zeta-plugin" });
    const withTopic = loadMarketplace();
    withTopic.marketplace.fetchCatalogsAsync();
    assert.ok(
      withTopic.execCalls.some((cmd) => cmd.includes("q=topic:zeta-plugin")),
      "an app declaring a topic must have it searched",
    );
  });
});
