import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// projects.js's own compiled `require("./env.js")` / `require("./app-descriptor.js")` chain runs
// through Node's native require cache, which vi.resetModules() does not clear, so a stale registry
// or a stale CONFIG_DIR survives from an earlier test unless purged here too.
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

function pinApp(projects) {
  writeFileSync(join(dir, "apps.json"), JSON.stringify({
    zeta: { id: "zeta", label: "Zeta", home: { candidates: [dir] }, projects },
  }));
  process.env.HUB_APPS_FILE = join(dir, "apps.json");
  process.env.HUB_CONFIG_DIR = dir;
  process.env.HUB_APP_ID = "zeta";
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "core-loader-projects-source-"));
  for (const key of KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  bustDistRequireCache();
  vi.resetModules();
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("queryProjects reads whatever source the app declares", () => {
  it("groups a declared history file by project, newest first, with distinct session counts", async () => {
    pinApp({ historyFile: "history.jsonl" });
    // beta is written first (so plain object-key insertion order is [beta, alpha]) but alpha's
    // later, higher timestamp must still sort it first: this fails if the sort is missing or reversed.
    const lines = [
      { project: "/repo/beta", sessionId: "s2", timestamp: 200 },
      { project: "/repo/alpha", sessionId: "s1", timestamp: 100 },
      { project: "/repo/alpha", sessionId: "s1", timestamp: 300 },
    ];
    writeFileSync(join(dir, "history.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");

    const { queryProjects } = await import("../dist/projects.js");
    const rows = queryProjects();

    expect(rows).toEqual([
      { directory: "/repo/alpha", last_used: 300, sessions: 1 },
      { directory: "/repo/beta", last_used: 200, sessions: 1 },
    ]);
  });

  it("answers no rows when the app declares neither a history file nor a session database", async () => {
    pinApp({});

    const { queryProjects } = await import("../dist/projects.js");

    expect(queryProjects()).toEqual([]);
  });

  it("answers no rows when the declared history file does not exist", async () => {
    pinApp({ historyFile: "history.jsonl" });

    const { queryProjects } = await import("../dist/projects.js");

    expect(queryProjects()).toEqual([]);
  });
});

// Driven by the registry through appProjects(), the way production reaches the writer, so the
// declaration itself is what the assertions exercise rather than a name the test hands over.
describe("writeProjectMarker records the project id under the app's declared name", () => {
  it("writes the marker file the registry declares", async () => {
    pinApp({ markerFile: "zeta-project" });
    const projectDir = join(dir, "project");
    mkdirSync(join(projectDir, ".git"), { recursive: true });

    const { appProjects } = await import("../dist/app-descriptor.js");
    const { writeProjectMarker } = await import("../dist/projects.js");
    writeProjectMarker(projectDir, appProjects().markerFile, "project-id-1");

    expect(readFileSync(join(projectDir, ".git", "zeta-project"), "utf8")).toBe("project-id-1");
  });

  it("writes nothing when the app declares no marker file", async () => {
    pinApp({});
    const projectDir = join(dir, "project");
    mkdirSync(join(projectDir, ".git"), { recursive: true });

    const { appProjects } = await import("../dist/app-descriptor.js");
    const { writeProjectMarker } = await import("../dist/projects.js");
    writeProjectMarker(projectDir, appProjects().markerFile, "project-id-1");

    expect(readdirSync(join(projectDir, ".git"))).toEqual([]);
  });
});
