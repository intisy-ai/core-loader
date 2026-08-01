import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { binaryOnPath } from "../dist/ensure-app.js";

describe("ensure-app: binaryOnPath", () => {
  let dir;
  let originalPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "core-loader-binpath-"));
    originalPath = process.env.PATH;
    process.env.PATH = dir + delimiter + (originalPath ?? "");
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds a binary present on PATH", () => {
    const ext = process.platform === "win32" ? ".EXE" : "";
    writeFileSync(join(dir, "mybinary" + ext), "");
    assert.equal(binaryOnPath("mybinary"), true);
  });

  it("returns false for a binary absent from PATH", () => {
    assert.equal(binaryOnPath("no-such-binary-anywhere"), false);
  });
});
