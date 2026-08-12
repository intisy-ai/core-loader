import { describe, it, expect } from "vitest";
import { declarationOf } from "./plugins.js";

describe("declarationOf", () => {
  it("returns null for a plugin that declares neither settings, actions, nor a screen", () => {
    expect(declarationOf({}, "p", "/bundle.js")).toBeNull();
  });

  it("carries a plugin that declares only a contributed screen, not just settings/actions", () => {
    const screen = { id: "config", label: "Config", layout: { kind: "stack" } };
    const declaration = declarationOf({ screens: [screen] }, "p", "/bundle.js");
    expect(declaration).not.toBeNull();
    expect(declaration.screens).toEqual([screen]);
    expect(declaration.items).toEqual([]);
    expect(declaration.actions).toEqual([]);
  });

  it("still carries a plugin that declares only settings fields", () => {
    const declaration = declarationOf({ defaults: { token: "" }, current: {} }, "p", "/bundle.js");
    expect(declaration).not.toBeNull();
    expect(declaration.items.length).toBeGreaterThan(0);
  });
});
