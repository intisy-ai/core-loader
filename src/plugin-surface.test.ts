import { afterEach, describe, expect, it } from "vitest";
import type { PluginManifest } from "@intisy-ai/api";
import { startPlugins } from "./plugin-host.js";
import {
  bundleFor,
  capabilityOf,
  ledgerRowFor,
  providerIds,
  readScreenData,
  readSettingsSchema,
  resetPluginHostForTests,
  runSettingsAction,
} from "./plugin-surface.js";

function runtime() {
  return {
    config: { all: () => ({}), get: () => undefined, set: async () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    paths: { home: "/home", repos: "/home/repos", plugin: "/home/plugin", cache: "/home/cache", config: "/home/config" },
    events: { publish: () => {}, subscribe: () => () => {} },
  };
}

function manifest(id: string, capabilities: string[]): PluginManifest {
  return { id, api: 1, entry: "dist/index.js", capabilities };
}

async function hostWith(...plugins: Array<{ manifest: PluginManifest; module: unknown }>) {
  const modules = new Map(plugins.map((plugin) => [`/home/plugin/${plugin.manifest.id}.js`, plugin.module]));
  const loaded = await startPlugins({
    app: "test",
    pluginDir: "/home/plugin",
    surfaces: ["tui"],
    runtimeFor: () => runtime() as never,
    scan: {
      loaded: plugins.map((plugin) => ({
        manifest: plugin.manifest,
        manifestPath: `/home/plugin/${plugin.manifest.id}.json`,
        entryPath: `/home/plugin/${plugin.manifest.id}.js`,
      })),
      failed: [],
    },
    importEntry: async (entryPath: string) => modules.get(entryPath),
  });
  resetPluginHostForTests(loaded);
  return loaded;
}

afterEach(() => resetPluginHostForTests(null));

describe("the surface's view of a running host", () => {
  it("answers with no providers, no bundle and no ledger row when no host started", () => {
    expect(providerIds("screens")).toEqual([]);
    expect(capabilityOf("demo", "screens")).toBeUndefined();
    expect(bundleFor("demo")).toBeNull();
    expect(ledgerRowFor("demo")).toBeNull();
  });

  it("names every plugin providing a capability and reaches one plugin's implementation", async () => {
    await hostWith(
      {
        manifest: manifest("alpha", ["screens"]),
        module: {
          default: {
            activate: (ctx: { provide: (id: string, value: unknown) => void }) =>
              ctx.provide("screens", {
                screens: () => [{ id: "s", label: "S", layout: { kind: "stack" } }],
                read: async () => ({ sources: { rows: [] } }),
                invoke: async () => ({ ok: true }),
              }),
            deactivate: () => {},
          },
        },
      },
      {
        manifest: manifest("beta", ["settings"]),
        module: {
          default: {
            activate: (ctx: { provide: (id: string, value: unknown) => void }) =>
              ctx.provide("settings", { schema: () => ({ fields: [{ key: "token", type: "string" }] }), run: async () => ({ ok: true, message: "ran" }) }),
            deactivate: () => {},
          },
        },
      },
    );

    expect(providerIds("screens")).toEqual(["alpha"]);
    expect(providerIds("settings")).toEqual(["beta"]);
    expect(capabilityOf("alpha", "settings")).toBeUndefined();
    expect(bundleFor("beta")).toBe("/home/plugin/beta.js");
    expect(await readSettingsSchema("beta")).toEqual({ fields: [{ key: "token", type: "string" }] });
    expect(await readScreenData("alpha", "s")).toEqual({ rows: [] });
    expect(await runSettingsAction("beta", "sync")).toEqual({ ok: true, message: "ran" });
  });

  it("turns a throwing capability call into a failed result rather than a quarantine", async () => {
    const loaded = await hostWith({
      manifest: manifest("angry", ["settings"]),
      module: {
        default: {
          activate: (ctx: { provide: (id: string, value: unknown) => void }) =>
            ctx.provide("settings", { schema: () => { throw new Error("no schema here"); }, run: async () => { throw new Error("boom"); } }),
          deactivate: () => {},
        },
      },
    });

    expect(await readSettingsSchema("angry")).toBeNull();
    expect(await runSettingsAction("angry", "go")).toEqual({ ok: false, message: "boom" });
    expect(loaded.host.ledger.entry("angry")?.status).toBe("active");
  });

  it("reports a quarantined plugin's reason as its ledger row", async () => {
    await hostWith({
      manifest: manifest("broken", ["settings"]),
      module: { default: { activate: () => { throw new Error("activate failed"); }, deactivate: () => {} } },
    });

    const row = ledgerRowFor("broken");
    expect(row?.status).toBe("broken");
    expect(row?.error?.detail).toContain("activate failed");
    expect(row?.error?.fix).toBeTruthy();
  });
});
