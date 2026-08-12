import { describe, it, expect } from "vitest";
import { collectScreens, subPages, entryId } from "./screens.js";

const spec = { id: "config", label: "Config", layout: { kind: "stack", children: [{ kind: "text", text: "hi" }] } };

describe("contributed screens in the loader", () => {
  it("collects one entry per screen a plugin declares", () => {
    const entries = collectScreens([{ name: "p", _cfg: { name: "p", screens: [spec] } }]);
    expect(entries).toEqual([{ plugin: "p", spec }]);
  });

  it("ignores a plugin with no screens", () => {
    expect(collectScreens([{ name: "p", _cfg: { name: "p" } }])).toEqual([]);
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
