// The menu reports the plugin actions it performs ITSELF, in plugin-updater's
// vocabulary, so a reader sees one set of actions whoever did the work. Driven through
// the real confirm handler against a temp home.
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

let home;
const savedEnv = {};
const ENV_KEYS = ["HUB_CONFIG_DIR", "HUB_OPENCODE_DIR", "CORE_APP"];

// env.ts derives REPOS_DIR / PLUGINS_DIR / CONFIG_DIR at import, so the home must be
// in place before the modules under test are required.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "core-loader-input-"));
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.HUB_CONFIG_DIR = home;
  process.env.HUB_OPENCODE_DIR = home;
  process.env.CORE_APP = "opencode";
  mkdirSync(join(home, "config"), { recursive: true });
  mkdirSync(join(home, "plugin"), { recursive: true });
  mkdirSync(join(home, "repos", "demo-plugin"), { recursive: true });
  writeFileSync(join(home, "plugin", "demo-plugin.js"), "// bundle");
  writeFileSync(join(home, "config", "plugins.json"), JSON.stringify([
    { name: "demo-plugin", url: "https://example.invalid/demo-plugin", enabled: true },
  ]));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(home, { recursive: true, force: true });
});

describe("menu plugin-action activity", () => {
  it("reports an uninstall it performed itself, using plugin-updater's vocabulary", () => {
    const seam = require("../dist/activity-seam.js");
    const { S } = require("../dist/state.js");
    const { handleConfirmKey } = require("../dist/input.js");

    const emitted = [];
    seam.setActivitySeam({ emit: (spec) => emitted.push(spec) });
    try {
      S.mode = "confirm";
      S.confirmCursor = 0;
      S.confirmAction = { type: "uninstall-plugin", target: { name: "demo-plugin", folderName: "demo-plugin", pluginFile: "demo-plugin.js" } };
      handleConfirmKey("y");

      // the action really happened, so the record is not describing a no-op
      assert.deepStrictEqual(JSON.parse(readFileSync(join(home, "config", "plugins.json"), "utf8")), []);
      assert.strictEqual(existsSync(join(home, "plugin", "demo-plugin.js")), false);

      const rec = emitted.find((e) => e.action === "uninstalled");
      assert.ok(rec, "expected an uninstalled record, got " + JSON.stringify(emitted));
      assert.strictEqual(rec.topic, "plugin.installed");
      assert.strictEqual(rec.impact, "notice");
      assert.strictEqual(rec.outcome, "ok");
      assert.strictEqual(rec.subject.id, "demo-plugin");
      assert.strictEqual(rec.details.kind, "git");
    } finally {
      seam.setActivitySeam(null);
      S.confirmAction = null;
      S.mode = "list";
    }
  });

  it("reports nothing when the user declines", () => {
    const seam = require("../dist/activity-seam.js");
    const { S } = require("../dist/state.js");
    const { handleConfirmKey } = require("../dist/input.js");

    const emitted = [];
    seam.setActivitySeam({ emit: (spec) => emitted.push(spec) });
    try {
      S.mode = "confirm";
      S.confirmCursor = 0;
      S.confirmAction = { type: "uninstall-plugin", target: { name: "demo-plugin", folderName: "demo-plugin" } };
      handleConfirmKey("n");

      assert.strictEqual(emitted.length, 0);
      assert.strictEqual(JSON.parse(readFileSync(join(home, "config", "plugins.json"), "utf8")).length, 1);
    } finally {
      seam.setActivitySeam(null);
      S.confirmAction = null;
      S.mode = "list";
    }
  });

  // The other three sites sit behind an in-process plugin-updater or a real npm/git
  // child, so this is the only check that fails if someone deletes their report call.
  it("reports at every menu site that performs the action itself", () => {
    const text = readFileSync(new URL("../src/input.ts", import.meta.url), "utf8");
    const calls = text.split("reportPluginAction(").length - 1;
    // one definition + five call sites: npm update, npm uninstall x2, git uninstall x2,
    // and the direct git-checkout downgrade
    assert.strictEqual(calls, 7, "expected 6 reportPluginAction call sites, found " + (calls - 1));
  });
});
