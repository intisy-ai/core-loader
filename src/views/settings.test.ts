// The Settings tab reads declarations from the cache and never blocks on one: a plugin whose
// declaration has not landed is a spinner row, and the tab is usable meanwhile.
//
// The global section reads a settings file off disk, so this file runs against a temp home. env.ts
// resolves CONFIG_DIR from HUB_CONFIG_DIR at IMPORT time, and a static import hoists above every
// statement, so the variable is pinned first and the modules under test then arrive through dynamic
// imports. The fixture is written to the path env.ts itself resolved, which is what makes the
// temp home provably the one being read.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_KEYS = ["HUB_CONFIG_DIR", "HUB_OPENCODE_DIR", "CORE_APP"];
const savedEnv: Record<string, string | undefined> = {};

// Written into the temp home only. `logConsole` contradicts its own default and `probeMarker` is not
// a declared setting at all, so either one showing up in the global section proves the tab read THIS
// home rather than the developer's.
const TEMP_HOME_SETTINGS = { logConsole: true, probeMarker: "temp-home-only" };

let home: string;
let configFolder: string;
let host: typeof import("@intisy-ai/api/host");
let surface: typeof import("../plugin-surface.js");
let plugins: typeof import("../plugins.js");
let state: typeof import("../state.js");
let view: typeof import("./settings.js");

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "core-loader-settings-"));
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.HUB_CONFIG_DIR = home;
  process.env.HUB_OPENCODE_DIR = home;
  process.env.CORE_APP = "opencode";

  const env = await import("../env.js");
  configFolder = env.CONFIG_FOLDER;
  // Refuse to write anywhere but the temp home. Should the pinning above ever stop taking effect,
  // env.ts resolves the DEVELOPER'S home instead, and the fixture write below would land in it: this
  // fails the run first, with nothing written.
  if (!configFolder.startsWith(home)) {
    throw new Error("refusing to touch a home outside the temp dir: " + configFolder);
  }
  mkdirSync(configFolder, { recursive: true });
  mkdirSync(env.PLUGINS_DIR, { recursive: true });
  writeFileSync(join(configFolder, "settings.json"), JSON.stringify(TEMP_HOME_SETTINGS));

  host = await import("@intisy-ai/api/host");
  surface = await import("../plugin-surface.js");
  plugins = await import("../plugins.js");
  state = await import("../state.js");
  view = await import("./settings.js");
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(home, { recursive: true, force: true });
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

async function hostWith(...declared: Array<{ id: string; capabilities: string[]; module: unknown }>) {
  const modules = new Map(declared.map((plugin) => [`/home/plugin/${plugin.id}.js`, plugin.module]));
  const loaded = await host.startPlugins({
    app: "test",
    pluginDir: "/home/plugin",
    surfaces: ["tui"],
    runtimeFor: () => runtime() as never,
    scan: {
      loaded: declared.map((plugin) => ({
        manifest: { id: plugin.id, api: 1, entry: "dist/index.js", capabilities: plugin.capabilities },
        manifestPath: `/home/plugin/${plugin.id}.json`,
        entryPath: `/home/plugin/${plugin.id}.js`,
      })),
      failed: [],
    },
    importEntry: async (entryPath: string) => modules.get(entryPath),
  });
  surface.resetPluginHostForTests(loaded);
  return loaded;
}

const TEST_IDS = ["sync-demo", "mute-demo", "strand-demo"];

afterEach(() => {
  surface.resetPluginHostForTests(null);
  for (const id of TEST_IDS) plugins.invalidateDeclaration(id);
  // refreshSettings' background read arms a redraw; left running it would paint the TUI over
  // whatever runs next.
  if (state.S.renderTimer) { clearTimeout(state.S.renderTimer); state.S.renderTimer = null; }
  state.S.catalogPending = 0;
  state.S.settingsEntries = null;
  state.S.settingsSections = null;
});

function loadingLabels() {
  return (state.S.settingsEntries || []).filter((entry) => entry.type === "loading").map((entry) => entry.label);
}

function sectionsOfKind(kind: string) {
  return (state.S.settingsEntries || []).filter((entry) => entry.type === "group" && entry.section.kind === kind).map((entry) => entry.section);
}

describe("the global section's home", () => {
  it("resolves the temp home, not the developer's own", () => {
    expect(configFolder.startsWith(home)).toBe(true);
  });

  it("reads the settings file from that home", () => {
    view.refreshSettings();

    const [global] = sectionsOfKind("global");
    const byKey = new Map(global.items.map((row: { key: string }) => [row.key, row]));
    expect(byKey.get("probeMarker")).toEqual({ key: "probeMarker", value: "temp-home-only", def: undefined, isSet: true, type: "string" });
    expect(byKey.get("logConsole")).toMatchObject({ value: true, def: false, isSet: true });
  });
});

describe("refreshSettings", () => {
  it("shows a plugin as loading until its declaration lands, then as its own group", async () => {
    await hostWith({ id: "sync-demo", capabilities: ["settings"], module: settingsPlugin({ actions: [{ id: "sync", label: "Sync now" }] }) });

    view.refreshSettings();
    expect(loadingLabels()).toEqual(["sync-demo"]);
    expect(sectionsOfKind("plugin")).toEqual([]);
    expect(sectionsOfKind("global")).toHaveLength(1);

    await plugins.readDeclaration("sync-demo");
    view.refreshSettings();

    expect(loadingLabels()).toEqual([]);
    const groups = sectionsOfKind("plugin");
    expect(groups).toHaveLength(1);
    expect(groups[0].plugin).toBe("sync-demo");
    expect(groups[0].items).toEqual([{ kind: "action", key: "sync", label: "Sync now" }]);
  });

  it("costs a plugin with nothing configurable its own section only, leaving the tab usable", async () => {
    await hostWith({ id: "mute-demo", capabilities: ["settings"], module: settingsPlugin({}) });

    await plugins.readDeclaration("mute-demo");
    view.refreshSettings();

    expect(loadingLabels()).toEqual([]);
    expect(sectionsOfKind("plugin")).toEqual([]);
    expect(sectionsOfKind("global")).toHaveLength(1);
  });

  it("still releases the read and still repaints when rebuilding the tab throws", async () => {
    await hostWith({ id: "strand-demo", capabilities: ["settings"], module: settingsPlugin({ actions: [{ id: "go", label: "Go" }] }) });

    view.refreshSettings();
    expect(state.S.catalogPending).toBe(1);
    expect(state.S.renderTimer).toBeNull();

    const savedCapabilities = state.S.capabilities;
    let redrawScheduled = null;
    try {
      // buildSectionsFromCache resolves the injected global-settings declaration, so a throwing one
      // makes the rebuild inside the read's own callback throw for real.
      state.S.capabilities = { globalSettings: { get defaults() { throw new Error("no defaults"); } } };
      await vi.waitFor(() => expect(state.S.catalogPending).toBe(0));
      redrawScheduled = state.S.renderTimer;
    } finally {
      if (state.S.renderTimer) { clearTimeout(state.S.renderTimer); state.S.renderTimer = null; }
      state.S.capabilities = savedCapabilities;
    }
    // The frame on screen still shows a spinner for a read that has landed, so the repaint has to
    // happen whether the rebuild worked or not.
    expect(redrawScheduled).not.toBeNull();

    // And the plugin stays readable: left in the in-flight set, it would never be read again.
    plugins.invalidateDeclaration("strand-demo");
    view.refreshSettings();
    expect(state.S.catalogPending).toBe(1);
    await vi.waitFor(() => expect(state.S.catalogPending).toBe(0));
    expect(loadingLabels()).toEqual([]);
  });

  it("lists no plugin row at all with no host running", () => {
    view.refreshSettings();

    expect(loadingLabels()).toEqual([]);
    expect(sectionsOfKind("plugin")).toEqual([]);
    expect(sectionsOfKind("global")).toHaveLength(1);
  });
});
