import { describe, expect, it } from "vitest";
import { secretMask } from "./format.js";
import { buildConfigItems } from "./plugins.js";

describe("a declared secret", () => {
  it("is typed by its declaration, not by the value it happens to hold", () => {
    const [row] = buildConfigItems({ defaults: { token: "" }, current: { token: "s3cr3t" }, fields: [{ key: "token", type: "secret" }] });
    expect(row.type).toBe("secret");
    expect(row.value).toBe("s3cr3t");
  });

  it("masks at a fixed width, so the display leaks no length", () => {
    expect(secretMask("s3cr3t")).toBe(secretMask("a-much-longer-token-value"));
    expect(secretMask("s3cr3t")).not.toContain("s3cr3t");
  });

  it("says so when there is nothing set, rather than masking emptiness", () => {
    expect(secretMask("")).toBe("(unset)");
    expect(secretMask(undefined)).toBe("(unset)");
    expect(secretMask(null)).toBe("(unset)");
  });
});
