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

  // `file` is read back as a real path (any surface reading a plugin's config must name the
  // same file), so it must follow the plugin's own config name and not the id sections route by.
  it("names the config file from the plugin's own reported config name", () => {
    const [section] = splitBySections({ ...declaration, configName: "demo-config" });
    expect(section.file).toBe("demo-config.json");
    expect(section.plugin).toBe("demo");
  });

  it("falls back to the routing id when the values probe reported no config name", () => {
    expect(splitBySections(declaration)[0].file).toBe("demo.json");
    expect(splitBySections({ ...declaration, configName: null })[0].file).toBe("demo.json");
  });
});
