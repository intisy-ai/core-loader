// A host that imports plugin modules for their API says so in a vocabulary no plugin's name
// appears in, so any plugin managing plugins is suppressed here, not one particular plugin.
import { describe, expect, it } from "vitest";

describe("the library-mode signal", () => {
  it("is set generically as soon as this library is imported", async () => {
    await import("./env.js");
    expect(process.env.INTISY_PLUGIN_LIBRARY_MODE).toBe("1");
  });
});
