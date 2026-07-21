import { describe, it } from "vitest";
import assert from "node:assert";
import { getMcpActions } from "../dist/mcp.js";

describe("mcp: getMcpActions", () => {
  it("offers uninstall for an installed server, install otherwise, always ending in cancel", () => {
    assert.deepEqual(getMcpActions({ installed: true, env: {}, args: [] }).map((a) => a.key), ["uninstall", "cancel"]);
    assert.deepEqual(getMcpActions({ installed: false, env: {}, args: [] }).map((a) => a.key), ["install", "cancel"]);
  });

  it("adds a configure action when the server declares env keys", () => {
    const acts = getMcpActions({ installed: true, env: { API_KEY: "" }, args: [] });
    assert.deepEqual(acts.map((a) => a.key), ["uninstall", "configure", "cancel"]);
  });

  it("adds a browser action when an arg looks like an npm package (has @ and isn't -y)", () => {
    const acts = getMcpActions({ installed: true, env: {}, args: ["-y", "@scope/pkg"] });
    assert.deepEqual(acts.map((a) => a.key), ["uninstall", "browser", "cancel"]);
  });

  it("combines configure + browser when both conditions hold", () => {
    const acts = getMcpActions({ installed: false, env: { TOKEN: "" }, args: ["-y", "some-pkg@1.0"] });
    assert.deepEqual(acts.map((a) => a.key), ["install", "configure", "browser", "cancel"]);
  });
});
