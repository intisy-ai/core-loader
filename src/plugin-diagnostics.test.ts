import { afterEach, describe, expect, it } from "vitest";
import { diagnosticLines } from "./plugin-diagnostics.js";
import { DIM, RED, WHITE } from "./format.js";
import { startPlugins } from "@intisy-ai/api/host";
import { resetPluginHostForTests } from "./plugin-surface.js";
import { S } from "./state.js";
import { buildPlugins } from "./views/plugins.js";

describe("diagnosticLines", () => {
  it("says so when the host never saw the plugin", () => {
    expect(diagnosticLines(null)).toEqual(["This plugin did not load through the plugin host."]);
  });

  it("reports an active plugin's capabilities and services", () => {
    expect(diagnosticLines({
      pluginId: "demo",
      status: "active",
      capabilitiesDeclared: ["settings"],
      capabilities: ["settings"],
      services: { provides: ["demo:store"], consumes: ["accounts"] },
      topics: ["config.changed"],
      permissions: ["network"],
      unresolved: [],
    })).toEqual([
      "Status: active",
      "Capabilities: settings",
      "Provides: demo:store",
      "Consumes: accounts",
      "Subscribes: config.changed",
      "Permissions: network",
    ]);
  });

  it("leads with the reason and the fix when the plugin is broken", () => {
    const lines = diagnosticLines({
      pluginId: "demo",
      status: "broken",
      capabilitiesDeclared: ["screens"],
      capabilities: [],
      services: { provides: [], consumes: [] },
      topics: [],
      permissions: [],
      unresolved: [],
      error: { detail: "activate did not finish within 10000ms", fix: "return from activate promptly" },
    });
    expect(lines[0]).toBe("Status: broken");
    expect(lines[1]).toBe("Reason: activate did not finish within 10000ms");
    expect(lines[2]).toBe("Fix: return from activate promptly");
    expect(lines).toContain("Declared but not provided: screens");
  });

  it("names a consumed service nothing in this home provides", () => {
    const lines = diagnosticLines({
      pluginId: "demo",
      status: "active",
      capabilitiesDeclared: [],
      capabilities: [],
      services: { provides: [], consumes: ["routing"] },
      topics: [],
      permissions: [],
      unresolved: ["routing"],
    });
    expect(lines).toContain("Unresolved: routing");
  });
});

describe("the diagnostics screen", () => {
  afterEach(() => {
    resetPluginHostForTests(null);
    S.mode = "list";
    S.pluginItems = [];
    S.hasUpdater = false;
  });

  async function hostWithBrokenPlugin() {
    const loaded = await startPlugins({
      app: "test",
      pluginDir: "/home/plugin",
      surfaces: ["tui"],
      runtimeFor: () => ({
        config: { all: () => ({}), get: () => undefined, set: async () => {} },
        log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        paths: { home: "/home", repos: "/home/repos", plugin: "/home/plugin", cache: "/home/cache", config: "/home/config" },
        events: { publish: () => {}, subscribe: () => () => {} },
      }) as never,
      scan: {
        loaded: [{
          manifest: { id: "broken", api: 1, entry: "dist/index.js", capabilities: ["settings"] },
          manifestPath: "/home/plugin/broken.json",
          entryPath: "/home/plugin/broken.js",
        }],
        failed: [],
      },
      importEntry: async () => ({ default: { activate: () => { throw new Error("activate failed"); }, deactivate: () => {} } }),
    });
    resetPluginHostForTests(loaded);
  }

  it("colours the reason as a problem and the status as the heading", async () => {
    await hostWithBrokenPlugin();
    S.page = "plugins";
    S.mode = "pdiag";
    S.pluginItems = [{ name: "broken", subject: "", url: "" }];
    S.pcursor = 0;
    // The Installed sub-page is gated on the updater engine being loadable, which it is not here.
    S.hasUpdater = true;

    const body: string[] = [];
    buildPlugins((line: string) => body.push(String(line)), () => {}, 120, 110, () => {});

    const status = body.find((line) => line.includes("Status: "));
    const reason = body.find((line) => line.includes("Reason: "));
    const fix = body.find((line) => line.includes("Fix: "));
    expect(status).toContain(WHITE);
    expect(reason).toContain(RED);
    expect(fix).toContain(DIM);
  });
});
