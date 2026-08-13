// The Settings tab reads declarations from the cache and never blocks on one: a plugin whose
// declaration has not landed is a spinner row, and the tab is usable meanwhile.
import { afterEach, describe, expect, it } from "vitest";
import { startPlugins } from "../plugin-host.js";
import { resetPluginHostForTests } from "../plugin-surface.js";
import { invalidateDeclaration, readDeclaration } from "../plugins.js";
import { S } from "../state.js";
import { refreshSettings } from "./settings.js";

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

async function hostWith(...plugins: Array<{ id: string; capabilities: string[]; module: unknown }>) {
  const modules = new Map(plugins.map((plugin) => [`/home/plugin/${plugin.id}.js`, plugin.module]));
  const loaded = await startPlugins({
    app: "test",
    pluginDir: "/home/plugin",
    surfaces: ["tui"],
    runtimeFor: () => runtime() as never,
    scan: {
      loaded: plugins.map((plugin) => ({
        manifest: { id: plugin.id, api: 1, entry: "dist/index.js", capabilities: plugin.capabilities },
        manifestPath: `/home/plugin/${plugin.id}.json`,
        entryPath: `/home/plugin/${plugin.id}.js`,
      })),
      failed: [],
    },
    importEntry: async (entryPath: string) => modules.get(entryPath),
  });
  resetPluginHostForTests(loaded);
  return loaded;
}

const TEST_IDS = ["sync-demo", "mute-demo"];

afterEach(() => {
  resetPluginHostForTests(null);
  for (const id of TEST_IDS) invalidateDeclaration(id);
  // refreshSettings' background read arms a redraw; left running it would paint the TUI over
  // whatever runs next.
  if (S.renderTimer) { clearTimeout(S.renderTimer); S.renderTimer = null; }
  S.catalogPending = 0;
  S.settingsEntries = null;
  S.settingsSections = null;
});

function loadingLabels() {
  return (S.settingsEntries || []).filter((entry) => entry.type === "loading").map((entry) => entry.label);
}

function pluginGroups() {
  return (S.settingsEntries || []).filter((entry) => entry.type === "group" && entry.section.kind === "plugin").map((entry) => entry.section);
}

function hasGlobalGroup() {
  return (S.settingsEntries || []).some((entry) => entry.type === "group" && entry.section.kind === "global");
}

describe("refreshSettings", () => {
  it("shows a plugin as loading until its declaration lands, then as its own group", async () => {
    await hostWith({ id: "sync-demo", capabilities: ["settings"], module: settingsPlugin({ actions: [{ id: "sync", label: "Sync now" }] }) });

    refreshSettings();
    expect(loadingLabels()).toEqual(["sync-demo"]);
    expect(pluginGroups()).toEqual([]);
    expect(hasGlobalGroup()).toBe(true);

    await readDeclaration("sync-demo");
    refreshSettings();

    expect(loadingLabels()).toEqual([]);
    const groups = pluginGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].plugin).toBe("sync-demo");
    expect(groups[0].items).toEqual([{ kind: "action", key: "sync", label: "Sync now" }]);
  });

  it("costs a plugin with nothing configurable its own section only, leaving the tab usable", async () => {
    await hostWith({ id: "mute-demo", capabilities: ["settings"], module: settingsPlugin({}) });

    await readDeclaration("mute-demo");
    refreshSettings();

    expect(loadingLabels()).toEqual([]);
    expect(pluginGroups()).toEqual([]);
    expect(hasGlobalGroup()).toBe(true);
  });

  it("lists no plugin row at all with no host running", () => {
    refreshSettings();

    expect(loadingLabels()).toEqual([]);
    expect(pluginGroups()).toEqual([]);
    expect(hasGlobalGroup()).toBe(true);
  });
});
