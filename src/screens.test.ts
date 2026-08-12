import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flattenScreen, screenRows } from "./screens.js";

const fixture = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "screen-fixture.json"), "utf8"));

describe("core-loader flatten", () => {
  it("agrees with core on kinds, labels and depths", () => {
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
});
