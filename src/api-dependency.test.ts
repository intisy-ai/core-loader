import { describe, expect, it } from "vitest";
import { API_VERSION } from "@intisy-ai/api";

describe("core-loader depends on the api package", () => {
  // Asserts resolution, not the number. Pinning the value here coupled a resolution check to a
  // constant that legitimately rises, so every api major bump broke this test in every consumer;
  // the value itself is pinned in api's own suite, against the version the Java emits.
  it("resolves the api package by its scoped name", () => {
    expect(typeof API_VERSION).toBe("number");
    expect(API_VERSION).toBeGreaterThanOrEqual(1);
  });
});
