import { describe, it, afterEach } from "vitest";
import assert from "node:assert";
import { createRequire } from "node:module";

// dist/*.js are plain CommonJS output; import()-ing them from this .mjs test
// via Vite's SSR interop and require()-ing them (transitively, from inside
// another dist file) can resolve to TWO separate module instances, so a
// mutation the test makes to S here would go unseen by buildActivity. Loading
// both through the SAME real Node require guarantees one shared S instance.
const require = createRequire(import.meta.url);
const { S } = require("../dist/state.js");
const { buildActivity } = require("../dist/views/activity.js");

function capture() {
  const body = [];
  const foot = [];
  const sticky = [];
  return {
    body,
    foot,
    sticky,
    pushBody: (line) => body.push(line),
    pushFoot: (line) => foot.push(line),
    pushSticky: (line) => sticky.push(line),
  };
}

describe("views/activity: buildActivity", () => {
  const savedCapabilities = S.capabilities;
  const savedRecords = S.activityRecords;
  const savedCursor = S.activityCursor;

  afterEach(() => {
    S.capabilities = savedCapabilities;
    S.activityRecords = savedRecords;
    S.activityCursor = savedCursor;
  });

  it("renders records newest-first with an impact glyph, source, and text", () => {
    const fixedTs = Date.now() - 60000;
    S.activityCursor = 0;
    S.capabilities = {
      activity: {
        read: () => [
          { id: "1", ts: fixedTs, source: "plugin-updater", impact: "notice", text: "Installed WakaTime 1.2.3" },
          { id: "2", ts: fixedTs, source: "core-proxy", impact: "error", text: "boom" },
        ],
      },
    };
    S.activityRecords = S.capabilities.activity.read();

    const { body, pushBody, pushFoot, pushSticky } = capture();
    buildActivity(pushBody, pushFoot, 80, 76, pushSticky);

    const joined = body.join("\n");
    assert.ok(joined.includes("boom"), "expected the error row's text to render");
    assert.ok(joined.includes("Installed WakaTime 1.2.3"), "expected the notice row's text to render");
    // RED = "\x1b[31m" is the error-impact glyph color (see format.ts).
    assert.ok(joined.includes("\x1b[31m"), "expected an error-colored glyph for the error row");
  });

  it("renders an empty-state line and does not throw when the capability is absent", () => {
    S.capabilities = {};
    S.activityRecords = [];

    const { body, pushBody, pushFoot, pushSticky } = capture();
    assert.doesNotThrow(() => buildActivity(pushBody, pushFoot, 80, 76, pushSticky));

    const joined = body.join("\n");
    assert.ok(/activity/i.test(joined), "expected an empty-state line mentioning activity");
  });

  it("renders an empty-state line when the capability is present but read() returns nothing", () => {
    S.capabilities = { activity: { read: () => [] } };
    S.activityRecords = [];

    const { body, pushBody, pushFoot, pushSticky } = capture();
    assert.doesNotThrow(() => buildActivity(pushBody, pushFoot, 80, 76, pushSticky));

    const joined = body.join("\n");
    assert.ok(/no activity yet/i.test(joined));
  });
});
