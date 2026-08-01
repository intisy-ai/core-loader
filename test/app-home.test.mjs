import { describe, it, afterEach } from "vitest";
import assert from "node:assert";
import { join } from "node:path";
import { loaderConfigDir, loaderReposDir } from "../dist/app-home.js";

describe("app-home: loaderConfigDir/loaderReposDir", () => {
  const original = process.env.HUB_CONFIG_DIR;

  afterEach(() => {
    if (original === undefined) delete process.env.HUB_CONFIG_DIR;
    else process.env.HUB_CONFIG_DIR = original;
  });

  it("falls back to the app default home when HUB_CONFIG_DIR is unset", () => {
    delete process.env.HUB_CONFIG_DIR;
    assert.equal(loaderConfigDir("/home/user/.claude"), "/home/user/.claude");
  });

  it("prefers HUB_CONFIG_DIR over the app default home", () => {
    process.env.HUB_CONFIG_DIR = "/custom/dir";
    assert.equal(loaderConfigDir("/home/user/.claude"), "/custom/dir");
  });

  it("derives reposDir as <configDir>/repos", () => {
    delete process.env.HUB_CONFIG_DIR;
    assert.equal(loaderReposDir("/home/user/.claude"), join("/home/user/.claude", "repos"));
    process.env.HUB_CONFIG_DIR = "/custom/dir";
    assert.equal(loaderReposDir("/home/user/.claude"), join("/custom/dir", "repos"));
  });
});
