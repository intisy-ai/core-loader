import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flattenScreen, screenRows } from "./screens.js";

const fixture = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "screen-fixture.json"), "utf8"));

describe("screen flatten", () => {
  it("collapses the fixture to its leaves, with their labels and depths", () => {
    const rows = flattenScreen(fixture.layout);
    expect(rows.map((r) => r.kind)).toEqual(["stats", "table", "chips", "text", "text"]);
    expect(rows.map((r) => r.label)).toEqual([undefined, "Changes / Pending", "Profiles", undefined, undefined]);
    expect(rows.map((r) => r.depth)).toEqual([0, 2, 1, 1, 1]);
  });

  it("renders one row per collection entry, under the block's label", () => {
    const rows = screenRows(fixture, { summary: [{ id: "a", label: "Pending", value: 2 }], pending: [{ id: "1", key: "theme" }], profiles: [] });
    expect(rows.some((r) => r.text.includes("Pending") && r.text.includes("2"))).toBe(true);
    expect(rows.some((r) => r.text.includes("theme"))).toBe(true);
  });

  it("keeps an unknown kind as a labelled row rather than dropping it silently", () => {
    expect(flattenScreen({ kind: "stack", children: [{ kind: "sparkline" }] })).toHaveLength(1);
  });

  it("surfaces a row it cannot render (form, fields, actions, meter) instead of vanishing it", () => {
    const spec = {
      id: "s",
      label: "S",
      layout: {
        kind: "stack",
        children: [
          { kind: "form", fields: [], submit: "go" },
          { kind: "fields", keys: ["token"] },
          { kind: "actions", ids: ["go"] },
          { kind: "meter", source: "quota" },
        ],
      },
    };
    const rows = screenRows(spec, {});
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.text === "Not available in the terminal.")).toBe(true);
  });
});

describe("layout depth", () => {
  function nested(levels, leaf) {
    let node = leaf;
    for (let i = 0; i < levels; i++) node = { kind: "stack", children: [node] };
    return node;
  }

  it("walks a deeply nested leaf up to the bound and stops past it", () => {
    expect(flattenScreen(nested(12, { kind: "text", text: "deep" }))).toHaveLength(1);
    expect(flattenScreen(nested(13, { kind: "text", text: "too deep" }))).toEqual([]);
  });

  it("terminates on a layout that nests into itself", () => {
    const cyclic = { kind: "stack", children: [] };
    cyclic.children.push(cyclic);
    expect(flattenScreen(cyclic)).toEqual([]);
  });
});

describe("per-surface layout", () => {
  it("prefers this surface's own tree and falls back to the shared layout", () => {
    const spec = {
      id: "s",
      label: "S",
      layout: { kind: "stack", children: [{ kind: "text", text: "shared" }] },
      surfaces: { tui: { kind: "table", source: "rows", empty: "No rows yet." }, watch: { kind: "text", text: "wrist" } },
    };
    expect(screenRows(spec, { rows: [] })).toEqual([{ text: "No rows yet.", depth: 0 }]);
    expect(screenRows({ ...spec, surfaces: { watch: { kind: "text", text: "wrist" } } }, {})).toEqual([
      { text: "shared", depth: 0 },
    ]);
  });
});
