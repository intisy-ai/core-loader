import { describe, expect, it } from "vitest";
import type { Plugin, PluginManifest, PluginRuntime } from "@intisy-ai/api";
import { startPlugins } from "./plugin-host.js";

function runtime(): PluginRuntime {
  return {
    config: { all: () => ({}), get: () => undefined, set: async () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    paths: { home: "/home", repos: "/home/repos", plugin: "/home/plugin", cache: "/home/cache", config: "/home/config" },
    events: { publish: () => {}, subscribe: () => () => {} },
  };
}

function manifest(id: string, extra: Partial<PluginManifest> = {}): PluginManifest {
  return { id, api: 1, entry: "dist/index.js", capabilities: ["settings"], ...extra };
}

function scanOf(...plugins: Array<{ manifest: PluginManifest; module: unknown }>) {
  return {
    loaded: plugins.map((plugin) => ({ manifest: plugin.manifest, manifestPath: `/home/plugin/${plugin.manifest.id}.json`, entryPath: `/home/plugin/${plugin.manifest.id}.js` })),
    failed: [],
    modules: new Map(plugins.map((plugin) => [`/home/plugin/${plugin.manifest.id}.js`, plugin.module])),
  };
}

function options(scan: ReturnType<typeof scanOf>, overrides: Record<string, unknown> = {}) {
  return {
    app: "test",
    pluginDir: "/home/plugin",
    runtimeFor: () => runtime(),
    scan,
    importEntry: async (entryPath: string) => scan.modules.get(entryPath),
    ...overrides,
  };
}

function settingsPlugin(record: string[], id: string): { default: Plugin } {
  return {
    default: {
      activate: (ctx) => {
        record.push(id);
        ctx.provide("settings", { schema: () => ({}), run: async () => ({ ok: true }) });
      },
      deactivate: () => {},
    },
  };
}

describe("startPlugins", () => {
  it("activates a manifest-declared plugin and exposes its capability", async () => {
    const order: string[] = [];
    const scan = scanOf({ manifest: manifest("demo"), module: settingsPlugin(order, "demo") });
    const loaded = await startPlugins(options(scan));

    expect(loaded.started).toEqual(["demo"]);
    expect(loaded.quarantined).toEqual([]);
    expect(loaded.host.capability("settings").map((record) => record.pluginId)).toEqual(["demo"]);
    expect(loaded.host.ledger.entry("demo")?.status).toBe("active");
  });

  it("activates a service provider before its consumer", async () => {
    const order: string[] = [];
    const scan = scanOf(
      { manifest: manifest("consumer", { capabilities: [], entry: "dist/index.js", services: { consumes: ["provider-plugin:store"] } }), module: { default: { activate: () => { order.push("consumer"); }, deactivate: () => {} } } },
      { manifest: manifest("provider-plugin", { capabilities: [], services: { provides: ["provider-plugin:store"] } }), module: { default: { activate: (ctx) => { order.push("provider-plugin"); ctx.services.register("provider-plugin:store", {}); }, deactivate: () => {} } } },
    );
    const loaded = await startPlugins(options(scan));

    expect(order).toEqual(["provider-plugin", "consumer"]);
    expect(loaded.host.service("provider-plugin:store")).toBeDefined();
  });

  it("quarantines both members of a dependency cycle and starts everything else", async () => {
    const order: string[] = [];
    const scan = scanOf(
      { manifest: manifest("left", { capabilities: [], services: { provides: ["left:a"], consumes: ["right:b"] } }), module: { default: { activate: () => { order.push("left"); }, deactivate: () => {} } } },
      { manifest: manifest("right", { capabilities: [], services: { provides: ["right:b"], consumes: ["left:a"] } }), module: { default: { activate: () => { order.push("right"); }, deactivate: () => {} } } },
      { manifest: manifest("free"), module: settingsPlugin(order, "free") },
    );
    const loaded = await startPlugins(options(scan));

    expect(loaded.started).toEqual(["free"]);
    expect(loaded.quarantined.map((error) => error.pluginId).sort()).toEqual(["left", "right"]);
    expect(loaded.quarantined[0].detail).toContain("cycle");
    expect(order).toEqual(["free"]);
  });

  it("quarantines a plugin whose activate throws, and keeps the rest running", async () => {
    const order: string[] = [];
    const scan = scanOf(
      { manifest: manifest("angry"), module: { default: { activate: () => { throw new Error("no disk"); }, deactivate: () => {} } } },
      { manifest: manifest("calm"), module: settingsPlugin(order, "calm") },
    );
    const loaded = await startPlugins(options(scan));

    expect(loaded.started).toEqual(["calm"]);
    expect(loaded.quarantined.map((error) => error.pluginId)).toEqual(["angry"]);
    expect(loaded.quarantined[0].detail).toContain("no disk");
    expect(loaded.host.ledger.entry("angry")?.status).toBe("broken");
    expect(loaded.host.capability("settings").map((record) => record.pluginId)).toEqual(["calm"]);
  });

  it("quarantines a plugin whose activate never settles, without hanging the host", async () => {
    const scan = scanOf({ manifest: manifest("hung"), module: { default: { activate: () => new Promise(() => {}), deactivate: () => {} } } });
    const loaded = await startPlugins(options(scan, { activateTimeoutMs: 20 }));

    expect(loaded.started).toEqual([]);
    expect(loaded.quarantined[0].pluginId).toBe("hung");
    expect(loaded.quarantined[0].detail).toContain("20ms");
  });

  it("quarantines a plugin that declares a capability it never provides", async () => {
    const scan = scanOf({ manifest: manifest("liar"), module: { default: { activate: () => {}, deactivate: () => {} } } });
    const loaded = await startPlugins(options(scan));

    expect(loaded.quarantined[0].pluginId).toBe("liar");
    expect(loaded.quarantined[0].detail).toContain("declared but never provided");
  });

  it("refuses a plugin whose api floor exceeds the host", async () => {
    const scan = scanOf({ manifest: manifest("future", { api: 99 }), module: settingsPlugin([], "future") });
    const loaded = await startPlugins(options(scan));

    expect(loaded.started).toEqual([]);
    expect(loaded.quarantined[0].detail).toContain("needs api 99");
    expect(loaded.host.ledger.entry("future")?.capabilitiesDeclared).toEqual(["settings"]);
  });

  it("quarantines a plugin whose entry exports no plugin, or exports one missing deactivate", async () => {
    const scan = scanOf(
      { manifest: manifest("empty"), module: { default: { nothing: true } } },
      { manifest: manifest("halfway"), module: { default: { activate: () => {} } } },
    );
    const loaded = await startPlugins(options(scan));

    expect(loaded.quarantined.map((error) => error.pluginId)).toEqual(["empty", "halfway"]);
    expect(loaded.quarantined[0].fix).toContain("export default");
    expect(loaded.quarantined[1].fix).toContain("export default");
  });

  it("quarantines a plugin whose runtime cannot be built, and keeps the rest running", async () => {
    const order: string[] = [];
    const scan = scanOf(
      { manifest: manifest("badconfig"), module: settingsPlugin(order, "badconfig") },
      { manifest: manifest("ok"), module: settingsPlugin(order, "ok") },
    );
    const loaded = await startPlugins(options(scan, {
      runtimeFor: (target: PluginManifest) => {
        if (target.id === "badconfig") throw new Error("malformed config/badconfig.json");
        return runtime();
      },
    }));

    expect(loaded.started).toEqual(["ok"]);
    expect(loaded.quarantined.map((error) => error.pluginId)).toEqual(["badconfig"]);
    expect(loaded.quarantined[0].detail).toContain("malformed config/badconfig.json");
    expect(order).toEqual(["ok"]);
  });

  it("skips a manifest with no deployed bundle rather than failing the run", async () => {
    const loaded = await startPlugins(options({
      loaded: [{ manifest: manifest("undeployed"), manifestPath: "/home/plugin/undeployed.json", entryPath: null }],
      failed: [],
      modules: new Map(),
    } as never));

    expect(loaded.started).toEqual([]);
    expect(loaded.quarantined[0].pluginId).toBe("undeployed");
    expect(loaded.quarantined[0].fix).toContain("deploy");
  });

  it("carries a manifest that failed to read straight into the quarantine list", async () => {
    const loaded = await startPlugins(options({
      loaded: [],
      failed: [new (await import("@intisy-ai/api")).PluginError("bad", "unreadable", "redeploy it")],
      modules: new Map(),
    } as never));

    expect(loaded.quarantined.map((error) => error.pluginId)).toEqual(["bad"]);
  });

  it("deactivates every started plugin on stop", async () => {
    const stopped: string[] = [];
    const scan = scanOf({
      manifest: manifest("closer"),
      module: {
        default: {
          activate: (ctx) => ctx.provide("settings", { schema: () => ({}), run: async () => ({ ok: true }) }),
          deactivate: () => { stopped.push("closer"); },
        },
      },
    });
    const loaded = await startPlugins(options(scan));
    await loaded.stop();

    expect(stopped).toEqual(["closer"]);
    expect(loaded.host.capability("settings")).toEqual([]);
    expect(loaded.host.ledger.entry("closer")?.status).toBe("stopped");
  });
});
