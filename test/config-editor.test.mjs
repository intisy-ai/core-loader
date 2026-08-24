// A saved config row is repainted from the value just written, before the asynchronous re-read
// lands. Without that, the frame drawn right after the keystroke still shows the old value, and a
// second Enter computes its next value from the stale one, writing the same value again instead of
// toggling back. Driven through the real key handler against a temp home and a real bundle.
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

let home;
let bundle;
const savedEnv = {};
const ENV_KEYS = ["HUB_CONFIG_DIR", "HUB_OPENCODE_DIR", "CORE_APP"];

// A bundle that answers `config set` without writing anything: the write channel is core's own and
// is covered where it lives, while this test is about the row the editor paints afterwards.
const BUNDLE = [
  'var argv = process.argv.slice(2);',
  'if (argv[0] === "config" && argv[1] === "schema") {',
  '  process.stdout.write(JSON.stringify({ name: "demo", defaults: { enabled: false }, current: {} }));',
  "}",
  "",
].join("\n");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "core-loader-cfgedit-"));
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.HUB_CONFIG_DIR = home;
  process.env.HUB_OPENCODE_DIR = home;
  process.env.CORE_APP = "opencode";
  mkdirSync(join(home, "config"), { recursive: true });
  mkdirSync(join(home, "plugin"), { recursive: true });
  writeFileSync(join(home, "config", "plugins.json"), "[]");
  bundle = join(home, "plugin", "demo.js");
  writeFileSync(bundle, BUNDLE);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(home, { recursive: true, force: true });
});

function openEditor(row) {
  const { S } = require("../dist/state.js");
  S.page = "plugins";
  S.mode = "pconfig";
  S.configItems = [row];
  S.configTarget = { name: "demo", plugin: "demo", bundle, file: "demo.json", items: S.configItems };
  S.cfgcursor = 0;
  S.configConfirm = null;
  S.busy = false;
  return S;
}

function closeEditor(S) {
  if (S.msgTimeout) { clearTimeout(S.msgTimeout); S.msgTimeout = null; }
  S.message = "";
  S.configTarget = null;
  S.configItems = [];
  S.mode = "list";
}

describe("the config editor's saved row", () => {
  it("shows the new value in the same frame as the key that wrote it", () => {
    const { handlePluginKey } = require("../dist/input.js");
    const S = openEditor({ key: "enabled", value: false, def: false, isSet: false, type: "boolean" });
    try {
      handlePluginKey("enter");

      assert.strictEqual(S.configItems[0].value, true, "the row must not still read false under a message saying it changed");
      assert.strictEqual(S.configItems[0].isSet, true, "an explicitly written key is no longer a default");
    } finally {
      closeEditor(S);
    }
  });

  it("toggles back on a second enter rather than writing the same value again", () => {
    const { handlePluginKey } = require("../dist/input.js");
    const S = openEditor({ key: "enabled", value: false, def: false, isSet: false, type: "boolean" });
    try {
      handlePluginKey("enter");
      assert.strictEqual(S.configItems[0].value, true, "the first enter must land the written value");
      handlePluginKey("enter");
      assert.strictEqual(S.configItems[0].value, false, "the second enter must toggle from the written value, not repeat the first write");
    } finally {
      closeEditor(S);
    }
  });

  it("keeps a numeric row numeric when the text input saves it", () => {
    const { handleConfigInputData } = require("../dist/input.js");
    const S = openEditor({ key: "port", value: 3000, def: 3000, isSet: false, type: "number" });
    S.mode = "pcfginput";
    S.configEditKey = "port";
    S.inputBuf = "4000";
    try {
      handleConfigInputData(Buffer.from([13]));   // enter saves

      assert.strictEqual(S.configItems[0].value, 4000);
      assert.strictEqual(S.configItems[0].isSet, true);
    } finally {
      closeEditor(S);
    }
  });
});
