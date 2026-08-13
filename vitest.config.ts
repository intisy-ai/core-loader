import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,mjs}", "src/**/*.test.ts"],
    setupFiles: ["test/temp-home.setup.ts"],
    // Several tests drive the real menu against real bundles and take a couple of seconds
    // each. Against the 5s default they passed alone and timed out under parallel load, which
    // reads as a flaky suite rather than as slow tests. A setup hook standing a temp home up
    // through dynamic imports is the same story against the 10s hook default.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
