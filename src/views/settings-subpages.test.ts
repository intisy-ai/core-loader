import { afterEach, describe, expect, it } from "vitest";
import { S } from "../state.js";
import { settingsSubPages } from "./settings.js";

afterEach(() => { S.screenSpecs = []; });

describe("settingsSubPages", () => {
  it("lists Settings alone when no plugin contributed a screen", () => {
    S.screenSpecs = [];
    expect(settingsSubPages().map((page) => page.id)).toEqual(["settings"]);
  });

  it("lists Settings then one sub-page per contributed screen, and nothing else", () => {
    S.screenSpecs = [
      { plugin: "demo", spec: { id: "history", label: "History", layout: { kind: "stack" } }, actions: [] },
    ];
    expect(settingsSubPages().map((page) => page.id)).toEqual(["settings", "demo:history"]);
  });
});
