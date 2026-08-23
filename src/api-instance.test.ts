import { describe, expect, it } from "vitest";
import { setDiagnosticSink } from "@intisy-ai/api/engine";
import type { ContextSurface, PluginRuntimeShape } from "@intisy-ai/api/engine";
import type { PluginManifest } from "@intisy-ai/api";
import { startPlugins } from "@intisy-ai/api/host";

function runtime(): PluginRuntimeShape {
  return {
    config: { all: () => ({}), get: () => undefined, set: async () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    paths: { home: "/home", repos: "/home/repos", plugin: "/home/plugin", cache: "/home/cache", config: "/home/config" },
    events: { publish: () => {}, subscribe: () => () => {} },
  } as PluginRuntimeShape;
}

const manifest: PluginManifest = { id: "diagnostic", api: 1, entry: "dist/index.js", capabilities: ["not-a-capability"] };

describe("the api the plugin host reports through", () => {
  it("is the instance core-loader installs its diagnostic sink on", async () => {
    const seen: string[] = [];
    setDiagnosticSink((message) => seen.push(message));
    try {
      const loaded = await startPlugins({
        app: "test",
        pluginDir: "/home/plugin",
        surfaces: ["tui"],
        vocabulary: [{ id: "settings" }],
        runtimeFor: () => runtime(),
        scan: { loaded: [{ manifest, manifestPath: "/home/plugin/diagnostic.json", entryPath: "/home/plugin/diagnostic.js" }], failed: [] },
        importEntry: async () => ({
          default: {
            activate: (ctx: ContextSurface) => { ctx.provide("not-a-capability", {}); },
            deactivate: () => {},
          },
        }),
      });
      await loaded.stop();
    } finally {
      setDiagnosticSink(null);
    }

    expect(seen).toEqual(['ignored unknown capability "not-a-capability" from diagnostic']);
  });
});
