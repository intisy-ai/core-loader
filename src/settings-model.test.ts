import { describe, expect, it } from "vitest";
import { splitBySections } from "./settings-model.js";

const declaration = {
  name: "demo",
  bundle: "/home/plugin/demo.js",
  items: [{ key: "enabled", value: true, def: false, isSet: true, type: "boolean" }],
  actions: [{ id: "run", label: "Run" }],
  sections: [{ id: "sync", label: "Sync", fields: ["enabled"], actions: ["run"] }],
};

describe("splitBySections", () => {
  it("names the owning plugin on a contributed section", () => {
    const [section] = splitBySections(declaration);
    expect(section.plugin).toBe("demo");
    expect(section.addedBy).toBe("demo");
    expect(section.sectionId).toBe("sync");
  });

  it("names the owning plugin on a plugin's own leftover group too", () => {
    const [section] = splitBySections({ ...declaration, sections: [] });
    expect(section.plugin).toBe("demo");
    expect(section.addedBy).toBeUndefined();
    expect(section.items).toHaveLength(2);
  });
});
