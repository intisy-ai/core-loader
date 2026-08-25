import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginManifest } from "@intisy-ai/api";
import { CONFIG_DIR, PLUGINS_DIR } from "./env.js";
import { getConfigDefaults, SCREENS, SETTINGS } from "@intisy-ai/core";
import { startPlugins } from "@intisy-ai/api/host";
import {
  bundleFor,
  capabilityOf,
  capabilityProviders,
  hostServices,
  invokeScreenAction,
  ledgerRowFor,
  pluginHost,
  providerIds,
  readScreenData,
  readScreenSpecs,
  readSettingsSchema,
  resetPluginHostForTests,
  runSettingsAction,
  startPluginHost,
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

describe("the home these tests write to", () => {
  // Four tests below reach tuiLog (a throwing schema, a throwing screens(), a throwing invoke, and
  // the hostless case). Without a pinned home each of them appends a log file to the developer's own
  // ~/.config/opencode, so the pin is asserted here rather than assumed.
  it("is inside the temp dir, never the developer's own", () => {
    expect(CONFIG_DIR).toBe(process.env.HUB_CONFIG_DIR);
    expect(CONFIG_DIR.startsWith(tmpdir())).toBe(true);
  });
});

describe("the surface's view of a running host", () => {
  it("answers with no providers, no bundle and no ledger row when no host started", async () => {
    expect(providerIds(SCREENS)).toEqual([]);
    expect(capabilityProviders("screens")).toEqual([]);
    expect(capabilityOf("demo", SCREENS)).toBeUndefined();
    expect(bundleFor("demo")).toBeNull();
    expect(ledgerRowFor("demo")).toBeNull();
    expect(pluginHost()).toBeNull();
    expect(await readScreenSpecs("demo")).toEqual([]);
    expect(await readScreenData("demo", "s")).toBeNull();
    expect(await readSettingsSchema("demo")).toBeNull();
    expect(await invokeScreenAction("demo", "s", "go", {})).toEqual({ ok: false, message: "plugin not available" });
    expect(await runSettingsAction("demo", "go")).toEqual({ ok: false, message: "plugin not available" });
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

    expect(providerIds(SCREENS)).toEqual(["alpha"]);
    expect(providerIds(SETTINGS)).toEqual(["beta"]);
    expect(capabilityOf("alpha", SETTINGS)).toBeUndefined();
    expect(bundleFor("beta")).toBe("/home/plugin/beta.js");
    expect(await readSettingsSchema("beta")).toEqual({ fields: [{ key: "token", type: "string" }], actions: [], sections: [] });
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

  it("lists every plugin providing a capability with its own implementation, in activation order", async () => {
    const alphaImpl = { screens: () => [], read: async () => ({ sources: {} }), invoke: async () => ({ ok: true }) };
    const betaImpl = { screens: () => [], read: async () => ({ sources: {} }), invoke: async () => ({ ok: true }) };
    await hostWith(
      {
        manifest: manifest("alpha", ["screens"]),
        module: {
          default: {
            activate: (ctx: { provide: (id: string, value: unknown) => void }) => ctx.provide("screens", alphaImpl),
            deactivate: () => {},
          },
        },
      },
      {
        manifest: manifest("beta", ["screens"]),
        module: {
          default: {
            activate: (ctx: { provide: (id: string, value: unknown) => void }) => ctx.provide("screens", betaImpl),
            deactivate: () => {},
          },
        },
      },
    );

    const providers = capabilityProviders("screens");
    expect(providers.map((provider) => provider.pluginId)).toEqual(["alpha", "beta"]);
    expect(providers[0].implementation).toBe(alphaImpl);
    expect(providers[1].implementation).toBe(betaImpl);
  });

  it("reads the screens a plugin declares, empties on no screens capability, and swallows a throwing declaration", async () => {
    await hostWith(
      {
        manifest: manifest("alpha", ["screens"]),
        module: {
          default: {
            activate: (ctx: { provide: (id: string, value: unknown) => void }) =>
              ctx.provide("screens", {
                screens: () => [
                  { id: "s1", label: "One", layout: { kind: "stack" } },
                  { id: "s2", label: "Two", layout: { kind: "stack" } },
                ],
                read: async () => ({ sources: {} }),
                invoke: async () => ({ ok: true }),
              }),
            deactivate: () => {},
          },
        },
      },
      {
        manifest: manifest("silent", []),
        module: { default: { activate: () => {}, deactivate: () => {} } },
      },
      {
        manifest: manifest("thrower", ["screens"]),
        module: {
          default: {
            activate: (ctx: { provide: (id: string, value: unknown) => void }) =>
              ctx.provide("screens", {
                screens: () => { throw new Error("no screens here"); },
                read: async () => ({ sources: {} }),
                invoke: async () => ({ ok: true }),
              }),
            deactivate: () => {},
          },
        },
      },
    );

    expect(await readScreenSpecs("alpha")).toEqual([
      { id: "s1", label: "One", layout: { kind: "stack" } },
      { id: "s2", label: "Two", layout: { kind: "stack" } },
    ]);
    expect(await readScreenSpecs("silent")).toEqual([]);
    expect(await readScreenSpecs("thrower")).toEqual([]);
  });

  it("runs a screen's action, degrades when no screens capability, and turns a throw into a failed result", async () => {
    const loaded = await hostWith(
      {
        manifest: manifest("doer", ["screens"]),
        module: {
          default: {
            activate: (ctx: { provide: (id: string, value: unknown) => void }) =>
              ctx.provide("screens", {
                screens: () => [],
                read: async () => ({ sources: {} }),
                invoke: async () => ({ ok: true, message: "did it", refresh: true }),
              }),
            deactivate: () => {},
          },
        },
      },
      {
        manifest: manifest("noscreens", []),
        module: { default: { activate: () => {}, deactivate: () => {} } },
      },
      {
        manifest: manifest("failer", ["screens"]),
        module: {
          default: {
            activate: (ctx: { provide: (id: string, value: unknown) => void }) =>
              ctx.provide("screens", {
                screens: () => [],
                read: async () => ({ sources: {} }),
                invoke: async () => { throw new Error("invoke exploded"); },
              }),
            deactivate: () => {},
          },
        },
      },
    );

    expect(await invokeScreenAction("doer", "s", "go", { x: 1 })).toEqual({ ok: true, message: "did it", refresh: true });
    expect(await invokeScreenAction("noscreens", "s", "go", {})).toEqual({ ok: false, message: "plugin not available" });
    expect(await invokeScreenAction("failer", "s", "go", {})).toEqual({ ok: false, message: "invoke exploded" });
    expect(loaded.host.ledger.entry("failer")?.status).toBe("active");
  });

  it("drops a screen with no usable layout, keeping a well-formed sibling", async () => {
    await hostWith({
      manifest: manifest("mixed", ["screens"]),
      module: {
        default: {
          activate: (ctx: { provide: (id: string, value: unknown) => void }) =>
            ctx.provide("screens", {
              screens: () => [
                { id: "no-layout", label: "No layout" },
                { id: "layout-not-an-object", label: "Bad layout", layout: "stack" },
                { id: "layout-without-kind", label: "Kindless", layout: {} },
                { id: "ok", label: "Ok", layout: { kind: "stack" } },
              ],
              read: async () => ({ sources: {} }),
              invoke: async () => ({ ok: true }),
            }),
          deactivate: () => {},
        },
      },
    });

    expect(await readScreenSpecs("mixed")).toEqual([{ id: "ok", label: "Ok", layout: { kind: "stack" } }]);
  });

  it("array-guards a settings declaration's lists, its own and each section's", async () => {
    await hostWith({
      manifest: manifest("sloppy", ["settings"]),
      module: {
        default: {
          activate: (ctx: { provide: (id: string, value: unknown) => void }) =>
            ctx.provide("settings", {
              schema: () => ({ fields: 3, actions: "sync", sections: [{ id: "s", label: "L", fields: 3 }, "not a section"] }),
              run: async () => ({ ok: true }),
            }),
          deactivate: () => {},
        },
      },
    });

    expect(await readSettingsSchema("sloppy")).toEqual({
      fields: [],
      actions: [],
      sections: [{ id: "s", label: "L", fields: [], actions: [] }],
    });
  });

  // A deployed plugin is a manifest sidecar beside its bundle, which is what the host reads. Written
  // for real here rather than stubbed, because the whole point of the seam is that nothing is handed
  // in: the runtime, the declarations and the ids all come from core.
  function deploy(id: string, manifest: Record<string, unknown>, module: string) {
    mkdirSync(PLUGINS_DIR, { recursive: true });
    // What deploy writes beside the bundles, so node reads them as ESM. The scan skips this name.
    writeFileSync(join(PLUGINS_DIR, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(PLUGINS_DIR, id + ".json"), JSON.stringify({ id, api: 1, entry: "dist/index.js", ...manifest }));
    writeFileSync(join(PLUGINS_DIR, id + ".js"), module);
    return () => { for (const ext of [".json", ".js"]) rmSync(join(PLUGINS_DIR, id + ext), { force: true }); };
  }

  it("builds every plugin's context from core, on this home", async () => {
    const probe = join(PLUGINS_DIR, "probe-context.json");
    const undeploy = deploy("prober", {}, `
import { writeFileSync } from "node:fs";
export default {
  activate: (ctx) => writeFileSync(${JSON.stringify(probe)}, JSON.stringify({
    home: ctx.paths.home,
    config: typeof ctx.config.all, log: typeof ctx.log.info, events: typeof ctx.events.publish,
  })),
  deactivate: () => {},
};
`);
    try {
      await startPluginHost();
      expect(pluginHost()).not.toBeNull();
      expect(JSON.parse(readFileSync(probe, "utf-8")))
        .toEqual({ home: CONFIG_DIR, config: "function", log: "function", events: "function" });
    } finally {
      undeploy();
      rmSync(probe, { force: true });
    }
  });

  // A slash command and a settings row are things a plugin DECLARES, so they must be registered for
  // one that is broken, disabled, or has simply never been activated.
  it("registers what the installed plugins declare even when nothing drives them", async () => {
    const undeploy = deploy("declarer", { config: { defaults: { retries: 3 } } }, "not importable");
    try {
      await startPluginHost();
      expect(getConfigDefaults("declarer")).toEqual({ retries: 3 });
    } finally {
      undeploy();
    }
  });

  it("carries on when a deployed sidecar is unreadable", async () => {
    mkdirSync(PLUGINS_DIR, { recursive: true });
    const sidecar = join(PLUGINS_DIR, "broken.json");
    writeFileSync(sidecar, "{ not json");
    try {
      await expect(startPluginHost()).resolves.toBeUndefined();
      expect(pluginHost()).not.toBeNull();
    } finally {
      rmSync(sidecar, { force: true });
    }
  });

  // The home is what the runtime is built from, so an unresolved one is where the host stops: the
  // same degradation rule as ever, reached now by the home rather than by an absent injection.
  // Re-imported without the suite's pinned home, since env.ts resolves it once at import.
  it("stays hostless when no app home resolves", async () => {
    const pinned = process.env.HUB_CONFIG_DIR;
    delete process.env.HUB_CONFIG_DIR;
    vi.resetModules();
    try {
      const fresh = await import("./plugin-surface.js");
      await expect(fresh.startPluginHost()).resolves.toBeUndefined();
      expect(fresh.pluginHost()).toBeNull();
    } finally {
      if (pinned === undefined) delete process.env.HUB_CONFIG_DIR;
      else process.env.HUB_CONFIG_DIR = pinned;
      vi.resetModules();
    }
  });
});

describe("hostServices", () => {
  it("takes the services the loader implements on a plugin's behalf", () => {
    const support = { capability: () => ({}) };
    expect(hostServices({ services: [{ id: "provider-support", implementation: support }] }))
      .toEqual([{ id: "provider-support", implementation: support }]);
  });

  it("reports nothing registered as none", () => {
    expect(hostServices({})).toEqual([]);
    expect(hostServices(undefined)).toEqual([]);
    expect(hostServices({ services: "provider-support" })).toEqual([]);
  });

  // Registering an id with nothing behind it would have a plugin find a service and call undefined,
  // which is worse than finding none: the plugin's own absence handling never runs.
  it("drops an entry carrying no id or no implementation", () => {
    expect(hostServices({ services: [{ id: "kept", implementation: 1 }, { id: "gone" }, { implementation: 2 }] }))
      .toEqual([{ id: "kept", implementation: 1 }]);
  });
});
