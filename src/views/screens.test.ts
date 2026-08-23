import { afterEach, describe, it, expect } from "vitest";
import { startPlugins } from "@intisy-ai/api/host";
import { resetPluginHostForTests } from "../plugin-surface.js";
import { S } from "../state.js";
import { buildContributedScreen, collectScreens, refreshScreenSpecs, refreshScreen, runScreenAction, subPages, entryId, resolveScreenAction } from "./screens.js";

const spec = { id: "config", label: "Config", layout: { kind: "stack", children: [{ kind: "text", text: "hi" }] } };

function runtime() {
  return {
    config: { all: () => ({}), get: () => undefined, set: async () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    paths: { home: "/home", repos: "/home/repos", plugin: "/home/plugin", cache: "/home/cache", config: "/home/config" },
    events: { publish: () => {}, subscribe: () => () => {} },
  };
}

function manifest(id, capabilities) {
  return { id, api: 1, entry: "dist/index.js", capabilities };
}

async function hostWith(...plugins) {
  const modules = new Map(plugins.map((plugin) => [`/home/plugin/${plugin.manifest.id}.js`, plugin.module]));
  const loaded = await startPlugins({
    app: "test",
    pluginDir: "/home/plugin",
    surfaces: ["tui"],
    runtimeFor: () => runtime(),
    scan: {
      loaded: plugins.map((plugin) => ({
        manifest: plugin.manifest,
        manifestPath: `/home/plugin/${plugin.manifest.id}.json`,
        entryPath: `/home/plugin/${plugin.manifest.id}.js`,
      })),
      failed: [],
    },
    importEntry: async (entryPath) => modules.get(entryPath),
  });
  resetPluginHostForTests(loaded);
  return loaded;
}

function screensPlugin(specs) {
  return {
    default: {
      activate: (ctx) => ctx.provide("screens", { screens: () => specs, read: async () => ({ sources: {} }), invoke: async () => ({ ok: true }) }),
      deactivate: () => {},
    },
  };
}

function screensAndSettingsPlugin(specs, actions) {
  return {
    default: {
      activate: (ctx) => {
        ctx.provide("screens", { screens: () => specs, read: async () => ({ sources: {} }), invoke: async () => ({ ok: true }) });
        ctx.provide("settings", { schema: () => ({ actions }), run: async () => ({ ok: true }) });
      },
      deactivate: () => {},
    },
  };
}

afterEach(() => {
  resetPluginHostForTests(null);
  S.screenSpecs = [];
  S.screenRows = [];
  S.screenFailed = null;
  S.settingsSubPage = "settings";
  if (S.renderTimer) { clearTimeout(S.renderTimer); S.renderTimer = null; }
});

function unreadableScreenPlugin() {
  return {
    default: {
      activate: (ctx) => ctx.provide("screens", {
        screens: () => [spec],
        read: async () => { throw new Error("no data here"); },
        invoke: async () => ({ ok: true }),
      }),
      deactivate: () => {},
    },
  };
}

function bodyOf(entry) {
  const body = [];
  buildContributedScreen((line) => body.push(String(line).replace(/\x1b\[[0-9;]*m/g, "")), () => {}, 120, 110, () => {}, entry);
  return body;
}

describe("a screen whose data could not be read", () => {
  it("renders as unreadable rather than as forever loading", async () => {
    await hostWith({ manifest: manifest("broken-read", ["screens"]), module: unreadableScreenPlugin() });
    const entry = { plugin: "broken-read", spec, actions: [] };
    S.settingsSubPage = entryId(entry);

    await refreshScreen(entry);

    expect(S.screenFailed).toBe(entryId(entry));
    expect(bodyOf(entry).some((line) => line.includes("Could not read this screen"))).toBe(true);
  });

  it("still renders as loading while the first read is outstanding", () => {
    expect(bodyOf({ plugin: "p", spec, actions: [] }).some((line) => line.includes("Loading…"))).toBe(true);
  });

  it("does not reject when rendering the rows throws, and says so on the screen", async () => {
    // A spec with no layout: the boundary drops one, so only a caller holding a hand-made entry can
    // reach the flattener with it, and that throw must not terminate the loader.
    const layoutless = { id: "layoutless", label: "Layoutless" };
    await hostWith({ manifest: manifest("reader", ["screens"]), module: screensPlugin([layoutless]) });
    const entry = { plugin: "reader", spec: layoutless, actions: [] };
    S.settingsSubPage = entryId(entry);

    await expect(refreshScreen(entry)).resolves.toBeUndefined();

    expect(S.screenFailed).toBe(entryId(entry));
  });
});

describe("runScreenAction", () => {
  it("reports the result to its callback", async () => {
    await hostWith({ manifest: manifest("doer", ["screens"]), module: screensPlugin([spec]) });
    const seen = [];

    await runScreenAction({ plugin: "doer", spec, actions: [] }, { actionId: "go" }, (answer) => seen.push(answer));

    expect(seen).toEqual([{ ok: true }]);
  });

  it("does not reject when the callback itself throws, and never calls it a second time", async () => {
    await hostWith({ manifest: manifest("doer", ["screens"]), module: screensPlugin([spec]) });
    let calls = 0;

    await expect(runScreenAction({ plugin: "doer", spec, actions: [] }, { actionId: "go" }, () => {
      calls++;
      throw new Error("the caller blew up");
    })).resolves.toBeUndefined();

    // The catch reports a failure so a caller's cleanup always runs, which must not re-enter a
    // callback that already ran and threw.
    expect(calls).toBe(1);
  });
});

describe("contributed screens in the loader", () => {
  it("collects one entry per screen a plugin declared", () => {
    const entries = collectScreens([{ plugin: "p", spec, actions: [] }]);
    expect(entries).toEqual([{ plugin: "p", spec, actions: [] }]);
  });

  it("carries the plugin's declared actions on each entry, for resolving a row action's metadata", () => {
    const action = { id: "restore", label: "Restore", confirm: "Overwrite uncommitted changes?", danger: true };
    const entries = collectScreens([{ plugin: "p", spec, actions: [action] }]);
    expect(entries).toEqual([{ plugin: "p", spec, actions: [action] }]);
  });

  it("collects nothing when no plugin declared a screen", () => {
    expect(collectScreens([])).toEqual([]);
  });

  it("lists Settings first, then one sub-page per screen, in declared order", () => {
    const a = { ...spec, id: "a", label: "Alpha", order: 20 };
    const b = { ...spec, id: "b", label: "Beta", order: 10 };
    const pages = subPages([{ plugin: "p", spec: a }, { plugin: "p", spec: b }]);
    expect(pages.map((page) => page.label)).toEqual(["Settings", "Beta", "Alpha"]);
  });

  it("computes the same sub-page id subPages assigns, so a stale refresh can recognize it's no longer active", () => {
    const entry = { plugin: "p", spec };
    expect(entryId(entry)).toBe("p:config");
    expect(subPages([entry])[1].id).toBe(entryId(entry));
  });
});

describe("resolveScreenAction", () => {
  it("resolves a row action id to its declared metadata", () => {
    const action = { id: "restore", label: "Restore", confirm: "Sure?", danger: true };
    expect(resolveScreenAction({ actions: [action] }, "restore")).toEqual(action);
  });

  it("falls back to the id as the label for a screen-only action the plugin never declared", () => {
    expect(resolveScreenAction({ actions: [] }, "go")).toEqual({ id: "go", label: "go" });
  });
});

describe("refreshScreenSpecs", () => {
  it("fills S.screenSpecs with one entry per declared spec, carrying that plugin's settings actions", async () => {
    const restore = { id: "restore", label: "Restore", confirm: "Sure?", danger: true };
    await hostWith(
      { manifest: manifest("alpha", ["screens"]), module: screensPlugin([spec]) },
      { manifest: manifest("beta", ["screens", "settings"]), module: screensAndSettingsPlugin([{ ...spec, id: "b" }], [restore]) },
    );

    await refreshScreenSpecs();

    expect(S.screenSpecs).toEqual([
      { plugin: "alpha", spec, actions: [] },
      { plugin: "beta", spec: { ...spec, id: "b" }, actions: [restore] },
    ]);
  });

  it("contributes no entry for a plugin whose screens() answers an empty array", async () => {
    await hostWith({ manifest: manifest("empty", ["screens"]), module: screensPlugin([]) });

    await refreshScreenSpecs();

    expect(S.screenSpecs).toEqual([]);
  });

  it("drops a malformed spec (missing label, a non-string id, or no layout) but keeps a well-formed sibling", async () => {
    const wellFormed = { ...spec, id: "ok" };
    const noLabel = { id: "no-label", layout: { kind: "stack" } };
    const numericId = { id: 42, label: "Numeric", layout: { kind: "stack" } };
    // Kept, this one lists as a sub-page whose every read throws inside the flattener.
    const noLayout = { id: "no-layout", label: "No layout" };
    await hostWith({ manifest: manifest("mixed", ["screens"]), module: screensPlugin([noLabel, numericId, noLayout, wellFormed]) });

    await refreshScreenSpecs();

    expect(S.screenSpecs).toEqual([{ plugin: "mixed", spec: wellFormed, actions: [] }]);
  });

  it("overwrites the previous S.screenSpecs on a second call rather than appending", async () => {
    await hostWith({ manifest: manifest("first", ["screens"]), module: screensPlugin([spec, { ...spec, id: "second" }]) });
    await refreshScreenSpecs();
    expect(S.screenSpecs).toHaveLength(2);

    resetPluginHostForTests(null);
    await hostWith({ manifest: manifest("later", ["screens"]), module: screensPlugin([{ ...spec, id: "only" }]) });
    await refreshScreenSpecs();

    expect(S.screenSpecs).toEqual([{ plugin: "later", spec: { ...spec, id: "only" }, actions: [] }]);
  });
});

describe("collectScreens with no argument", () => {
  it("maps S.screenSpecs when called bare, the shape settingsSubPages relies on", () => {
    S.screenSpecs = [{ plugin: "p", spec, actions: [] }];
    expect(collectScreens()).toEqual([{ plugin: "p", spec, actions: [] }]);
  });

  it("answers nothing when the cache is empty", () => {
    S.screenSpecs = [];
    expect(collectScreens()).toEqual([]);
  });
});
