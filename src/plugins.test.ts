import { describe, expect, it } from "vitest";
import { declarationOf } from "./plugins.js";

const values = { defaults: { token: "" }, current: { token: "abc" } };

describe("declarationOf", () => {
  it("is null for a plugin that declares no settings and no actions", () => {
    expect(declarationOf("p", "/bundle.js", {}, { defaults: {}, current: {} })).toBeNull();
  });

  it("builds editable rows from the probed values and the declared fields", () => {
    const declaration = declarationOf("p", "/bundle.js", { fields: [{ key: "token", type: "secret" }] }, values);
    expect(declaration.name).toBe("p");
    expect(declaration.bundle).toBe("/bundle.js");
    expect(declaration.items).toEqual([{ key: "token", value: "abc", def: "", isSet: true, type: "string" }]);
  });

  it("carries the declared actions and sections through", () => {
    const schema = {
      actions: [{ id: "sync", label: "Sync now" }],
      sections: [{ id: "s", label: "S", actions: ["sync"] }],
    };
    const declaration = declarationOf("p", "/bundle.js", schema, { defaults: {}, current: {} });
    expect(declaration.actions).toEqual([{ id: "sync", label: "Sync now" }]);
    expect(declaration.sections).toEqual([{ id: "s", label: "S", actions: ["sync"] }]);
  });

  it("is a declaration even with no values probed, when the plugin declares an action", () => {
    const declaration = declarationOf("p", null, { actions: [{ id: "go", label: "Go" }] }, null);
    expect(declaration.items).toEqual([]);
    expect(declaration.actions).toEqual([{ id: "go", label: "Go" }]);
  });
});
