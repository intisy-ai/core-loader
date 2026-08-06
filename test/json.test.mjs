import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, readJsonc } from "../dist/json.js";

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cl-json-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(name, text) {
  const at = join(dir, name);
  writeFileSync(at, text);
  return at;
}

describe("readJson", () => {
  it("reads a file that parses", () => {
    assert.deepEqual(readJson(write("a.json", '{"x":1}')), { x: 1 });
    assert.deepEqual(readJson(write("b.json", "[1,2]")), [1, 2]);
  });

  // The caller decides what absent means, because [] and {} are wrong for each other.
  it("returns the caller's fallback for a missing, empty or malformed file", () => {
    assert.equal(readJson(join(dir, "gone.json")), null);
    assert.deepEqual(readJson(join(dir, "gone.json"), {}), {});
    assert.deepEqual(readJson(write("empty.json", ""), []), []);
    assert.deepEqual(readJson(write("bad.json", "{ not json"), {}), {});
  });

  // A file holding literal null parses fine, and handing that back would defeat the fallback
  // the caller asked for.
  it("treats a literal null as no answer", () => {
    assert.deepEqual(readJson(write("null.json", "null"), {}), {});
  });

  it("keeps falsy values that are real answers", () => {
    assert.equal(readJson(write("zero.json", "0"), 7), 0);
    assert.equal(readJson(write("false.json", "false"), true), false);
  });
});

describe("readJsonc", () => {
  it("tolerates whole-line // comments", () => {
    assert.deepEqual(readJsonc(write("c.json", '// header\n{"x":1}\n')), { x: 1 });
  });

  // Stripping anything that looks like a comment would corrupt a URL in a string value.
  it("leaves a // inside a string alone", () => {
    assert.deepEqual(readJsonc(write("u.json", '{"url":"https://a.test/x"}')), { url: "https://a.test/x" });
  });

  it("falls back like readJson when it still cannot parse", () => {
    assert.deepEqual(readJsonc(write("bad.json", "// only a comment"), {}), {});
  });
});
