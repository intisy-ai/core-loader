import { describe, expect, it } from "vitest";
import { diagnosticLines } from "./plugin-diagnostics.js";

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
