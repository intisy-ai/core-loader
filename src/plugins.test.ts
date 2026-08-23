import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlugins } from "@intisy-ai/api/host";
import { resetPluginHostForTests } from "./plugin-surface.js";
import { splitBySections } from "./settings-model.js";
import {
  declarationFor,
  declarationOf,
  getPluginActions,
  hostPluginId,
  invalidateDeclaration,
  probeConfigValuesAsync,
  readDeclaration,
  settingsPluginIds,
} from "./plugins.js";

const values = { defaults: { token: "" }, current: { token: "abc" } };

describe("declarationOf", () => {
  it("is null for a plugin that declares no settings and no actions", () => {
    expect(declarationOf("p", "/bundle.js", {}, { defaults: {}, current: {} })).toBeNull();
  });

  it("types a row by the plugin's declaration when it made one, so a secret can be masked", () => {
    const declaration = declarationOf("p", "/bundle.js", { fields: [{ key: "token", type: "secret" }] }, values);
    expect(declaration.items).toEqual([{ key: "token", value: "abc", def: "", isSet: true, type: "secret" }]);
  });

  it("falls back to the value's own type for a key the plugin declared no field for", () => {
    const declaration = declarationOf("p", "/bundle.js", {}, { defaults: { retries: 3 }, current: {} });
    expect(declaration.items).toEqual([{ key: "retries", value: 3, def: 3, isSet: false, type: "number" }]);
  });

  it("carries the declared actions and sections through", () => {
    const schema = {
      actions: [{ id: "sync", label: "Sync now" }],
      sections: [{ id: "s", label: "S", actions: ["sync"] }],
    };
    const declaration = declarationOf("p", "/bundle.js", schema, { defaults: {}, current: {} });
    expect(declaration.actions).toEqual([{ id: "sync", label: "Sync now" }]);
    expect(declaration.sections).toEqual([{ id: "s", label: "S", actions: ["sync"] }]);
  });

  it("is a declaration even with no values probed, when the plugin declares an action", () => {
    const declaration = declarationOf("p", null, { actions: [{ id: "go", label: "Go" }] }, null);
    expect(declaration.items).toEqual([]);
    expect(declaration.actions).toEqual([{ id: "go", label: "Go" }]);
  });

  it("keeps the plugin's own config name apart from the id surfaces route by", () => {
    const named = declarationOf("plugin-id", null, { actions: [{ id: "go", label: "Go" }] }, { name: "config-name", defaults: {}, current: {} });
    expect(named.name).toBe("plugin-id");
    expect(named.configName).toBe("config-name");
    expect(declarationOf("plugin-id", null, { actions: [{ id: "go", label: "Go" }] }, null).configName).toBeNull();
  });
});

describe("hostPluginId", () => {
  it("derives the host's id from the deployed file, which is not always the entry's name", () => {
    expect(hostPluginId({ name: "demo" })).toBe("demo");
    expect(hostPluginId({ name: "listed-as", pluginFile: "deployed-as.js" })).toBe("deployed-as");
  });
});

function runtime() {
  return {
    config: { all: () => ({}), get: () => undefined, set: async () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    paths: { home: "/home", repos: "/home/repos", plugin: "/home/plugin", cache: "/home/cache", config: "/home/config" },
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

const silentPlugin = { default: { activate: () => {}, deactivate: () => {} } };

async function hostWith(...plugins: Array<{ id: string; capabilities: string[]; module: unknown; entryPath?: string }>) {
  const entryOf = (plugin: { id: string; entryPath?: string }) => plugin.entryPath ?? `/home/plugin/${plugin.id}.js`;
  const modules = new Map(plugins.map((plugin) => [entryOf(plugin), plugin.module]));
  const loaded = await startPlugins({
    app: "test",
    pluginDir: "/home/plugin",
    surfaces: ["tui"],
    runtimeFor: () => runtime() as never,
    scan: {
      loaded: plugins.map((plugin) => ({
        manifest: { id: plugin.id, api: 1, entry: "dist/index.js", capabilities: plugin.capabilities },
        manifestPath: `/home/plugin/${plugin.id}.json`,
        entryPath: entryOf(plugin),
      })),
      failed: [],
    },
    importEntry: async (entryPath: string) => modules.get(entryPath),
  });
  resetPluginHostForTests(loaded);
  return loaded;
}

// Every id any test below reads or caches, cleared between tests so one test's cached
// declaration can never satisfy the next one's assertion.
const TEST_IDS = ["cache-demo", "has-settings", "no-settings", "empty-settings", "gated", "sloppy", "seen"];

afterEach(() => {
  resetPluginHostForTests(null);
  for (const id of TEST_IDS) invalidateDeclaration(id);
});

describe("the declaration cache", () => {
  it("answers unread, then the declaration, then unread again once invalidated", async () => {
    await hostWith({ id: "cache-demo", capabilities: ["settings"], module: settingsPlugin({ actions: [{ id: "go", label: "Go" }] }) });

    expect(declarationFor("cache-demo")).toBeUndefined();

    const declaration = await readDeclaration("cache-demo");
    expect(declaration.actions).toEqual([{ id: "go", label: "Go" }]);
    expect(declarationFor("cache-demo")).toBe(declaration);

    invalidateDeclaration("cache-demo");
    expect(declarationFor("cache-demo")).toBeUndefined();
  });

  it("caches null for a settings plugin that declares nothing configurable, which is not 'unread'", async () => {
    await hostWith({ id: "empty-settings", capabilities: ["settings"], module: settingsPlugin({}) });

    expect(await readDeclaration("empty-settings")).toBeNull();
    expect(declarationFor("empty-settings")).toBeNull();
  });
});

describe("a declaration whose lists are not lists", () => {
  it("splits into sections without throwing, because the boundary guarded them", async () => {
    await hostWith({
      id: "sloppy",
      capabilities: ["settings"],
      module: settingsPlugin({ actions: [{ id: "go", label: "Go" }], sections: [{ id: "s", label: "L", fields: 3, actions: 7 }] }),
    });

    const declaration = await readDeclaration("sloppy");
    expect(() => splitBySections(declaration)).not.toThrow();
    // Its section claimed nothing resolvable, so the action stays in the plugin's own group.
    expect(splitBySections(declaration).map((section: { label: string }) => section.label)).toEqual(["sloppy"]);
  });
});

describe("the diagnostics action", () => {
  const keysOf = (actions: Array<{ key: string }>) => actions.map((action) => action.key);

  it("is offered wherever the host recorded a row, and never for a plugin it never loads", async () => {
    await hostWith({ id: "seen", capabilities: [], module: silentPlugin });

    expect(keysOf(getPluginActions({ type: "npm", name: "seen" }))).toEqual(["diagnostics", "update-npm", "uninstall-npm", "cancel"]);
    expect(keysOf(getPluginActions({ name: "seen", enabled: false }))).toEqual(["enable-plugin", "diagnostics", "cancel"]);
    expect(keysOf(getPluginActions({ name: "seen", enabled: true }))).toContain("diagnostics");
    // The host never loads a plugin the app itself manages, so there is never a row to show.
    expect(keysOf(getPluginActions({ foreign: true, name: "seen", enabled: true }))).not.toContain("diagnostics");
    expect(keysOf(getPluginActions({ name: "stranger", enabled: false }))).toEqual(["enable-plugin", "cancel"]);
  });
});

describe("settingsPluginIds", () => {
  it("names only the plugins providing the settings capability", async () => {
    await hostWith(
      { id: "has-settings", capabilities: ["settings"], module: settingsPlugin({ actions: [{ id: "go", label: "Go" }] }) },
      { id: "no-settings", capabilities: [], module: silentPlugin },
    );

    expect(settingsPluginIds()).toEqual(["has-settings"]);
  });

  it("names nobody with no host running", () => {
    expect(settingsPluginIds()).toEqual([]);
  });
});

describe("probeConfigValuesAsync against a real bundle", () => {
  let dir: string;
  let bundle: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "core-loader-probe-"));
    bundle = join(dir, "gated.js");
    writeFileSync(bundle, [
      'if (process.argv.slice(2).join(" ") === "config schema") {',
      '  process.stdout.write(JSON.stringify({ name: "gated-config", defaults: { token: "", port: 3000 }, current: { port: 4000 } }));',
      "}",
      "",
    ].join("\n"));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the config name, the declared defaults and what is on disk", async () => {
    expect(await probeConfigValuesAsync(bundle)).toEqual({
      name: "gated-config",
      defaults: { token: "", port: 3000 },
      current: { port: 4000 },
    });
  });

  it("answers null for no bundle and for a bundle that is not deployed", async () => {
    expect(await probeConfigValuesAsync(null)).toBeNull();
    expect(await probeConfigValuesAsync(join(dir, "absent.js"))).toBeNull();
  });

  it("offers Configure for a plugin with editable rows, found by its deployed file rather than its listed name", async () => {
    await hostWith({ id: "gated", capabilities: ["settings"], module: settingsPlugin({ fields: [{ key: "port", type: "number" }] }), entryPath: bundle });

    const declaration = await readDeclaration("gated");
    expect(declaration.items.map((row: { key: string }) => row.key).sort()).toEqual(["port", "token"]);
    expect(declaration.items.find((row: { key: string }) => row.key === "port")).toEqual({ key: "port", value: 4000, def: 3000, isSet: true, type: "number" });
    expect(declaration.configName).toBe("gated-config");

    const listedByItsOwnName = getPluginActions({ type: "npm", name: "gated" });
    expect(listedByItsOwnName.map((action: { key: string }) => action.key)).toEqual(["configure", "diagnostics", "update-npm", "uninstall-npm", "cancel"]);
    expect(listedByItsOwnName[0].label).toBe("Configure settings (2)");

    const deployedUnderAnotherName = getPluginActions({ type: "npm", name: "listed-as", pluginFile: "gated.js" });
    expect(deployedUnderAnotherName.map((action: { key: string }) => action.key)).toEqual(["configure", "diagnostics", "update-npm", "uninstall-npm", "cancel"]);

    expect(getPluginActions({ type: "npm", name: "stranger" }).map((action: { key: string }) => action.key)).toEqual(["update-npm", "uninstall-npm", "cancel"]);
  });
});
