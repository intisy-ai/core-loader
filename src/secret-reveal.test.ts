import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlugins } from "./plugin-host.js";
import { resetPluginHostForTests } from "./plugin-surface.js";
import { getPluginActions, invalidateDeclaration, readDeclaration } from "./plugins.js";
import { PLUGINS_DIR } from "./env.js";
import { S } from "./state.js";
import { handleConfigInputData, handlePluginKey, handleSettingsKey } from "./input.js";
import { buildPlugins } from "./views/plugins.js";

const STRIP = /\x1b\[[0-9;]*m/g;

function secretRow(overrides: Record<string, unknown> = {}) {
  return { key: "token", value: "s3cr3t", def: "", isSet: true, type: "secret", ...overrides };
}

function boolRow() {
  return { key: "flag", value: true, def: true, isSet: true, type: "boolean" };
}

function openPluginEditor(rows: unknown[], bundle = "/does-not-exist.js") {
  S.page = "plugins";
  S.mode = "pconfig";
  S.hasUpdater = true;   // bypasses the "install the updater first" gate buildPlugins renders otherwise
  S.configItems = rows;
  S.configTarget = { name: "demo", plugin: "demo", bundle, file: "demo.json", items: rows };
  S.cfgcursor = 0;
  S.cfgReveal = "";
  S.configConfirm = null;
}

function renderPluginBody(): string[] {
  const body: string[] = [];
  buildPlugins((line: unknown) => body.push(String(line).replace(STRIP, "")), () => {}, 120, 110, () => {});
  return body;
}

afterEach(() => {
  S.mode = "list";
  S.hasUpdater = false;
  S.configItems = [];
  S.configTarget = null;
  S.cfgcursor = 0;
  S.cfgReveal = "";
  S.configConfirm = null;
  S.pluginItems = [];
  S.pcursor = 0;
  S.pacursor = 0;
  S.settingsEntries = [];
  S.settingsCursor = 0;
  S.settingsSubPage = "settings";
  S.inputBuf = "";
  S.configEditKey = "";
});

describe("a secret field that also declares options", () => {
  it("still opens the masked text editor on Enter, rather than cycling its options in cleartext", () => {
    openPluginEditor([secretRow({ options: ["a", "b"] })]);

    handlePluginKey("enter");

    expect(S.mode).toBe("pcfginput");
    expect(S.inputBuf).toBe("");
    expect(S.configItems[0].value).toBe("s3cr3t");
  });
});

describe("the reveal key", () => {
  it("sets the reveal to the secret row under the cursor, and a second press clears it", () => {
    openPluginEditor([secretRow()]);
    handlePluginKey("r");
    expect(S.cfgReveal).toBe("token");
    handlePluginKey("r");
    expect(S.cfgReveal).toBe("");
  });

  it("does nothing on a row that is not declared secret", () => {
    openPluginEditor([boolRow()]);
    handlePluginKey("r");
    expect(S.cfgReveal).toBe("");
  });

  it("is offered in the Settings tab's editor too", () => {
    S.mode = "pconfig";
    S.settingsSubPage = "settings";
    S.configItems = [secretRow()];
    S.cfgcursor = 0;
    S.cfgReveal = "";
    handleSettingsKey("r");
    expect(S.cfgReveal).toBe("token");
    handleSettingsKey("r");
    expect(S.cfgReveal).toBe("");
  });
});

describe("the reveal's lifetime", () => {
  it("clears when the cursor moves away from the revealed row", () => {
    openPluginEditor([secretRow(), boolRow()]);
    handlePluginKey("r");
    expect(S.cfgReveal).toBe("token");
    handlePluginKey("down");
    expect(S.cfgReveal).toBe("");
  });

  it("clears when the cursor moves in the Settings tab's editor", () => {
    S.mode = "pconfig";
    S.settingsSubPage = "settings";
    S.configItems = [secretRow(), boolRow()];
    S.cfgcursor = 0;
    S.cfgReveal = "token";
    handleSettingsKey("down");
    expect(S.cfgReveal).toBe("");
  });

  it("clears on leaving the Plugins tab's editor", () => {
    openPluginEditor([secretRow()]);
    handlePluginKey("r");
    expect(S.cfgReveal).toBe("token");
    handlePluginKey("escape");
    expect(S.mode).toBe("pactions");
    expect(S.cfgReveal).toBe("");
  });

  it("clears on leaving the Settings tab's editor", () => {
    S.mode = "pconfig";
    S.settingsSubPage = "settings";
    S.configItems = [secretRow()];
    S.cfgcursor = 0;
    S.cfgReveal = "token";
    handleSettingsKey("escape");
    expect(S.mode).toBe("list");
    expect(S.cfgReveal).toBe("");
  });

  // Regression for the round trip a revealed secret survives: reveal it, press Enter to edit
  // (the cursor never moves, so the up/down/escape clears above never fire), then leave the text
  // editor either way. Neither exit may leave a stale reveal naming a row whose on-screen value
  // could be a value the user just typed, not the one they revealed.
  it("clears the instant the text editor opens for the revealed row", () => {
    openPluginEditor([secretRow()]);
    handlePluginKey("r");
    expect(S.cfgReveal).toBe("token");

    handlePluginKey("enter");

    expect(S.mode).toBe("pcfginput");
    expect(S.cfgReveal).toBe("");
  });

  it("stays clear on an escape out of the text editor, even if something left it set", () => {
    openPluginEditor([secretRow()]);
    S.mode = "pcfginput";
    S.configEditKey = "token";
    S.inputBuf = "freshly-typed";
    S.cfgReveal = "token";

    handleConfigInputData(Buffer.from([27]));

    expect(S.mode).toBe("pconfig");
    expect(S.cfgReveal).toBe("");
  });

  it("stays clear after saving a freshly typed value, so the very next frame renders masked, not cleartext", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-loader-reveal-save-"));
    const bundle = join(dir, "demo.js");
    writeFileSync(bundle, "");
    try {
      openPluginEditor([secretRow()], bundle);
      S.mode = "pcfginput";
      S.configEditKey = "token";
      S.inputBuf = "freshly-typed";
      S.cfgReveal = "token";

      handleConfigInputData(Buffer.from([13]));

      expect(S.mode).toBe("pconfig");
      expect(S.cfgReveal).toBe("");
      expect(S.configItems[0].value).toBe("freshly-typed");
      const body = renderPluginBody();
      const row = body.find((line) => line.includes("token"));
      expect(row).toBeDefined();
      expect(row).not.toContain("freshly-typed");
      expect(row).toContain("••••••••");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a masked value in the rendered rows", () => {
  it("renders the mask when not revealed, and the real value once revealed", () => {
    openPluginEditor([secretRow()]);
    const maskedRow = renderPluginBody().find((line) => line.includes("token"));
    expect(maskedRow).toContain("••••••••");
    expect(maskedRow).not.toContain("s3cr3t");

    S.cfgReveal = "token";
    const revealedRow = renderPluginBody().find((line) => line.includes("token"));
    expect(revealedRow).toContain("s3cr3t");
  });

  it("says '(unset)' rather than masking emptiness", () => {
    openPluginEditor([secretRow({ value: "", isSet: false })]);
    const row = renderPluginBody().find((line) => line.includes("token"));
    expect(row).toContain("(unset)");
  });
});

describe("a revealed secret does not survive switching to a different plugin's editor", () => {
  let dir: string;

  function runtime() {
    return {
      config: { all: () => ({}), get: () => undefined, set: async () => {} },
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      paths: { home: PLUGINS_DIR, repos: PLUGINS_DIR, plugin: PLUGINS_DIR, cache: PLUGINS_DIR, config: PLUGINS_DIR },
      events: { publish: () => {}, subscribe: () => () => {} },
    };
  }

  function settingsPlugin(schema: unknown) {
    return {
      default: {
        activate: (ctx: { provide: (id: string, value: unknown) => void }) =>
          ctx.provide("settings", { schema: () => schema, run: async () => ({ ok: true }) }),
        deactivate: () => {},
      },
    };
  }

  async function hostWith(...plugins: Array<{ id: string; entryPath: string }>) {
    const modules = new Map(
      plugins.map((plugin) => [plugin.entryPath, settingsPlugin({ fields: [{ key: "token", type: "secret" }] })]),
    );
    const loaded = await startPlugins({
      app: "test",
      pluginDir: PLUGINS_DIR,
      surfaces: ["tui"],
      runtimeFor: () => runtime() as never,
      scan: {
        loaded: plugins.map((plugin) => ({
          manifest: { id: plugin.id, api: 1, entry: "dist/index.js", capabilities: ["settings"] },
          manifestPath: join(PLUGINS_DIR, plugin.id + ".json"),
          entryPath: plugin.entryPath,
        })),
        failed: [],
      },
      importEntry: async (entryPath: string) => modules.get(entryPath),
    });
    resetPluginHostForTests(loaded);
    return loaded;
  }

  beforeAll(() => {
    dir = PLUGINS_DIR;
    mkdirSync(dir, { recursive: true });
    const schemaAnswer = (name: string) =>
      [
        'var argv = process.argv.slice(2);',
        'if (argv[0] === "config" && argv[1] === "schema") {',
        `  process.stdout.write(JSON.stringify({ name: "${name}", defaults: { token: "" }, current: { token: "s3cr3t" } }));`,
        "}",
        "",
      ].join("\n");
    writeFileSync(join(dir, "alpha.js"), schemaAnswer("alpha-config"));
    writeFileSync(join(dir, "beta.js"), schemaAnswer("beta-config"));
  });

  afterAll(() => {
    rmSync(join(dir, "alpha.js"), { force: true });
    rmSync(join(dir, "beta.js"), { force: true });
  });

  afterEach(() => {
    resetPluginHostForTests(null);
    invalidateDeclaration("alpha");
    invalidateDeclaration("beta");
  });

  it("clears the reveal when the Plugins tab's Configure opens a different plugin", async () => {
    await hostWith({ id: "alpha", entryPath: join(dir, "alpha.js") }, { id: "beta", entryPath: join(dir, "beta.js") });
    await readDeclaration("alpha");
    await readDeclaration("beta");

    S.pluginItems = [{ name: "alpha", enabled: true }, { name: "beta", enabled: true }];
    S.pcursor = 0;
    S.mode = "pactions";
    S.pacursor = getPluginActions(S.pluginItems[0]).findIndex((action: { key: string }) => action.key === "configure");
    expect(S.pacursor).toBeGreaterThanOrEqual(0);

    handlePluginKey("enter");
    expect(S.configTarget?.plugin).toBe("alpha");
    expect(S.configItems[0].type).toBe("secret");
    handlePluginKey("r");
    expect(S.cfgReveal).toBe("token");

    // Force the reveal back on after leaving alpha's editor, isolating what the Configure arm's
    // own clear does (rather than relying on the escape arm's clear, already covered above) when it
    // opens a DIFFERENT plugin whose declaration happens to share the same field key.
    handlePluginKey("escape");
    S.cfgReveal = "token";
    S.mode = "pactions";
    S.pcursor = 1;
    S.pacursor = getPluginActions(S.pluginItems[1]).findIndex((action: { key: string }) => action.key === "configure");
    expect(S.pacursor).toBeGreaterThanOrEqual(0);

    handlePluginKey("enter");

    expect(S.configTarget?.plugin).toBe("beta");
    expect(S.configItems[0].type).toBe("secret");
    expect(S.cfgReveal).toBe("");

    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
