import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,mjs}", "src/**/*.test.ts"],
    // Several tests drive the real menu against real bundles and take a couple of seconds
    // each. Against the 5s default they passed alone and timed out under parallel load, which
    // reads as a flaky suite rather than as slow tests.
    testTimeout: 30000,
  },
});
