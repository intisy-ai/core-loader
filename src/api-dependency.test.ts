import { describe, expect, it } from "vitest";
import { API_VERSION, CAPABILITY_IDS, WELL_KNOWN_SERVICES } from "@intisy-ai/api";

describe("core-loader depends on the api package", () => {
  // Asserts resolution, not the number. Pinning the value here coupled a resolution check to a
  // constant that legitimately rises, so every api major bump broke this test in every consumer;
  // the value itself is pinned in api's own suite, against the version the Java emits.
  it("resolves the api package by its scoped name", () => {
    expect(typeof API_VERSION).toBe("number");
    expect(API_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("sees the capability vocabulary api owns", () => {
    expect([...CAPABILITY_IDS]).toContain("plugin-management");
  });

  it("sees the activity service this ecosystem added", () => {
    expect([...WELL_KNOWN_SERVICES]).toContain("activity");
  });
});
