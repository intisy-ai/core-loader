import { describe, it } from "vitest";
import assert from "node:assert";
import { rule, stringWidth, pad, trunc, timeAgo, isBooleanRowOn } from "../dist/format.js";

describe("format: stringWidth/pad/trunc", () => {
  it("stringWidth counts ASCII as 1, CJK as 2, and ignores ANSI escape codes", () => {
    assert.equal(stringWidth("abc"), 3);
    assert.equal(stringWidth("你好"), 4);
    assert.equal(stringWidth("\x1b[31mred\x1b[0m"), 3);
    assert.equal(stringWidth(""), 0);
    assert.equal(stringWidth(undefined), 0);
  });

  it("pad appends spaces up to the target visual width, and leaves an already-wide string alone", () => {
    assert.equal(pad("ab", 5), "ab   ");
    assert.equal(pad("你好", 5), "你好 ");
    assert.equal(pad("toolong", 3), "toolong");
  });

  it("trunc leaves short strings alone and ellipsizes long ones within the width budget", () => {
    assert.equal(trunc("short", 10), "short");
    const t = trunc("a very long string that overflows", 10);
    assert.ok(t.endsWith("..."));
    assert.ok(stringWidth(t) <= 10);
  });
});

describe("format: rule/timeAgo", () => {
  it("rule draws a gray divider of the requested width, reset at the end", () => {
    const r = rule(5);
    assert.ok(r.includes("─".repeat(5)));
    assert.ok(r.startsWith("\x1b[90m"));
    assert.ok(r.endsWith("\x1b[0m"));
  });

  it("timeAgo buckets a timestamp into now/minutes/hours/days, and '--' for falsy", () => {
    const now = Date.now();
    assert.equal(timeAgo(0), "--");
    assert.equal(timeAgo(now), "now");
    assert.equal(timeAgo(now - 5 * 60000), "5m ago");
    assert.equal(timeAgo(now - 3 * 3600000), "3h ago");
    assert.equal(timeAgo(now - 2 * 86400000), "2d ago");
  });
});

describe("format: isBooleanRowOn", () => {
  it("is true for the real boolean and the string \"true\", false for a drifted value", () => {
    assert.equal(isBooleanRowOn(true), true);
    assert.equal(isBooleanRowOn("true"), true);
    assert.equal(isBooleanRowOn(false), false);
    assert.equal(isBooleanRowOn("false"), false);
    assert.equal(isBooleanRowOn(""), false);
    assert.equal(isBooleanRowOn(undefined), false);
  });
});

describe("a declared accent colour", () => {
  it("maps a hex colour onto the ANSI 256 cube exactly", async () => {
    const { ansi256FromHex } = await import("../dist/format.js");
    assert.equal(ansi256FromHex("#d7875f"), "\x1b[38;5;173m");
    assert.equal(ansi256FromHex("#5fafaf"), "\x1b[38;5;73m");
  });

  it("answers empty for a value that is not a colour, so the caller keeps its default", async () => {
    const { ansi256FromHex } = await import("../dist/format.js");
    assert.equal(ansi256FromHex(""), "");
    assert.equal(ansi256FromHex("teal"), "");
  });
});
