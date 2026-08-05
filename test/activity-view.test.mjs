// The activity page shows WHERE an event ran and WHY, and can be narrowed by impact
// through the injected reader (core-loader never reads the log itself).
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { S } = require("../dist/state.js");
const { buildActivity } = require("../dist/views/activity.js");
const { handleActivityKey } = require("../dist/input.js");

function collect() {
  const body = [];
  const foot = [];
  const sticky = [];
  return {
    body,
    foot,
    sticky,
    // 120 columns: wide enough for the app and cause columns to render
    args: [(l) => body.push(l), (l) => foot.push(l), 120, 110, (l) => sticky.push(l)],
  };
}

function record(over) {
  return {
    id: over.id || "1",
    ts: Date.now(),
    impact: over.impact || "info",
    source: over.source || "core-proxy",
    text: over.text || "something happened",
    origin: over.origin,
    cause: over.cause,
  };
}

beforeEach(() => {
  S.capabilities = { activity: { read: () => [] } };
  S.activityRecords = [record({ impact: "error", text: "rate limited", origin: { app: "someapp" }, cause: { kind: "api" } })];
  S.activityCursor = 0;
  S.activityScrollOff = 0;
  S.activityImpacts = [];
});

afterEach(() => {
  S.capabilities = {};
  S.activityRecords = [];
  S.activityImpacts = [];
});

describe("activity view", () => {
  it("shows the app the event ran in and why it happened", () => {
    const c = collect();
    buildActivity(...c.args);
    const rendered = c.body.join("\n");
    assert.ok(rendered.includes("someapp"), "expected the origin app: " + rendered);
    assert.ok(rendered.includes("api"), "expected the cause kind: " + rendered);
  });

  it("renders a record with no origin or cause without printing undefined", () => {
    S.activityRecords = [record({ text: "old style event" })];
    const c = collect();
    buildActivity(...c.args);
    const rendered = c.body.join("\n");
    assert.ok(rendered.includes("old style event"));
    assert.ok(!rendered.includes("undefined"), "must not leak undefined: " + rendered);
  });

  it("drops the extra columns on a narrow terminal rather than truncating the message", () => {
    S.activityRecords = [record({ text: "Installed something with a long name", origin: { app: "someapp" }, cause: { kind: "api" } })];
    const narrow = collect();
    buildActivity((l) => narrow.body.push(l), (l) => narrow.foot.push(l), 80, 76, (l) => narrow.sticky.push(l));
    const rendered = narrow.body.join("\n");
    assert.ok(rendered.includes("Installed something"), "the message must survive: " + rendered);
    assert.ok(!rendered.includes("someapp"), "the app column must be dropped when narrow: " + rendered);
  });

  it("names the active impact filter in the header instead of hiding it", () => {
    S.activityImpacts = ["error", "warning"];
    const c = collect();
    buildActivity(...c.args);
    const header = c.sticky.join("\n");
    assert.ok(header.includes("error"), "expected the filter in the header: " + header);
    assert.ok(header.includes("warning"), "expected every active impact: " + header);
  });
});

describe("activity impact filter", () => {
  it("cycles the filter and asks the injected reader for exactly that set", () => {
    const queries = [];
    S.capabilities = { activity: { read: (query) => { queries.push(query); return []; } } };

    handleActivityKey("i");
    handleActivityKey("i");

    assert.deepStrictEqual(S.activityImpacts, ["error", "warning"]);
    assert.deepStrictEqual(queries[0], { limit: 200, impacts: ["error"] });
    assert.deepStrictEqual(queries[1], { limit: 200, impacts: ["error", "warning"] });
  });

  it("returns to no filter at the end of the cycle, and then asks for everything", () => {
    const queries = [];
    S.capabilities = { activity: { read: (query) => { queries.push(query); return []; } } };

    for (let i = 0; i < 4; i++) handleActivityKey("i");

    assert.deepStrictEqual(S.activityImpacts, []);
    assert.deepStrictEqual(queries[queries.length - 1], { limit: 200 });
  });

  it("keeps working against a host whose reader ignores the query", () => {
    S.capabilities = { activity: { read: () => [record({ id: "9", text: "from an older host" })] } };
    handleActivityKey("i");
    assert.strictEqual(S.activityRecords.length, 1);
    assert.strictEqual(S.activityRecords[0].text, "from an older host");
  });
});
