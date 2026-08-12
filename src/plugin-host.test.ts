import { describe, expect, it } from "vitest";
import type { Plugin, PluginManifest, PluginRuntime } from "@intisy-ai/api";
import { ledgerRows, startPlugins } from "./plugin-host.js";

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

describe("ledgerRows", () => {
  it("reports what each plugin declared, provided, consumed and subscribed to", async () => {
    const scan = scanOf({
      manifest: manifest("recorder", { permissions: ["network"], services: { provides: ["recorder:store"] } }),
      module: {
        default: {
          activate: (ctx) => {
            ctx.provide("settings", { schema: () => ({}), run: async () => ({ ok: true }) });
            ctx.services.register("recorder:store", {});
            ctx.services.get("accounts");
            ctx.events.subscribe("config.changed", () => {});
          },
          deactivate: () => {},
        },
      },
    });
    const loaded = await startPlugins(options(scan));
    const [row] = ledgerRows(loaded);

    expect(row.pluginId).toBe("recorder");
    expect(row.status).toBe("active");
    expect(row.capabilitiesDeclared).toEqual(["settings"]);
    expect(row.capabilities).toEqual(["settings"]);
    expect(row.services.provides).toEqual(["recorder:store"]);
    expect(row.services.consumes).toEqual(["accounts"]);
    expect(row.topics).toEqual(["config.changed"]);
    expect(row.permissions).toEqual(["network"]);
    expect(row.error).toBeUndefined();
  });

  it("names a consumed service nothing in this home provides", async () => {
    const scan = scanOf({
      manifest: manifest("lonely", { capabilities: [] }),
      module: { default: { activate: (ctx) => { ctx.services.get("routing"); }, deactivate: () => {} } },
    });
    const [row] = ledgerRows(await startPlugins(options(scan)));

    expect(row.unresolved).toEqual(["routing"]);
  });

  it("carries a quarantined plugin's error and fix", async () => {
    const scan = scanOf({ manifest: manifest("angry"), module: { default: { activate: () => { throw new Error("no disk"); }, deactivate: () => {} } } });
    const [row] = ledgerRows(await startPlugins(options(scan)));

    expect(row.status).toBe("broken");
    expect(row.error?.detail).toContain("no disk");
    expect(row.error?.fix).toBeTruthy();
  });

  it("does not list a consumed service as unresolved if another active plugin provides it", async () => {
    const scan = scanOf(
      { manifest: manifest("provider", { capabilities: [], services: { provides: ["provider:store"] } }), module: { default: { activate: (ctx) => { ctx.services.register("provider:store", {}); }, deactivate: () => {} } } },
      { manifest: manifest("consumer", { capabilities: [], services: { consumes: ["provider:store"] } }), module: { default: { activate: (ctx) => { ctx.services.get("provider:store"); }, deactivate: () => {} } } },
    );
    const loaded = await startPlugins(options(scan));
    const [, consumerRow] = ledgerRows(loaded);

    expect(consumerRow.pluginId).toBe("consumer");
    expect(consumerRow.services.consumes).toEqual(["provider:store"]);
    expect(consumerRow.unresolved).toEqual([]);
  });

  it("lists a consumed service as unresolved if its provider was quarantined or stopped", async () => {
    const scan = scanOf(
      { manifest: manifest("provider", { capabilities: [], services: { provides: ["provider:store"] } }), module: { default: { activate: (ctx) => { ctx.services.register("provider:store", {}); }, deactivate: () => {} } } },
      { manifest: manifest("consumer", { capabilities: [], services: { consumes: ["provider:store"] } }), module: { default: { activate: (ctx) => { ctx.services.get("provider:store"); }, deactivate: () => {} } } },
    );
    const loaded = await startPlugins(options(scan));
    await loaded.host.markBroken("provider", new (await import("@intisy-ai/api")).PluginError("provider", "stopped", "restart it"));
    const rows = ledgerRows(loaded);
    const consumerRow = rows.find((row) => row.pluginId === "consumer")!;

    expect(consumerRow.services.consumes).toEqual(["provider:store"]);
    expect(consumerRow.unresolved).toEqual(["provider:store"]);
  });

  it("carries capabilitiesDeclared for an early-quarantined plugin", async () => {
    const scan = scanOf({ manifest: manifest("future", { api: 99 }), module: { default: { activate: () => {}, deactivate: () => {} } } });
    const [row] = ledgerRows(await startPlugins(options(scan)));

    expect(row.pluginId).toBe("future");
    expect(row.status).toBe("broken");
    expect(row.capabilitiesDeclared).toEqual(["settings"]);
    expect(row.capabilities).toEqual([]);
    expect(row.error).toBeTruthy();
  });
});
