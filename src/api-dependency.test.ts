import { describe, expect, it } from "vitest";
import { API_VERSION, CAPABILITY_IDS, WELL_KNOWN_SERVICES } from "@intisy-ai/api";

describe("core-loader depends on the api package", () => {
  it("resolves the api package by its scoped name", () => {
    expect(API_VERSION).toBe(1);
  });

  it("sees the capability vocabulary api owns", () => {
    expect([...CAPABILITY_IDS]).toContain("plugin-management");
  });

  it("sees the activity service this ecosystem added", () => {
    expect([...WELL_KNOWN_SERVICES]).toContain("activity");
  });
});
