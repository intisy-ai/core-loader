// The Libraries tab reports what is resolvable from this home. The reading comes from
// plugin-updater (the thing that fills the store), so core-loader keeps no second copy of
// the rules and has nothing to show when the updater is absent.
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { S } = require("../dist/state.js");
const { librariesTab } = require("../dist/views/libraries.js");

function collect() {
  const body = [];
  const foot = [];
  const sticky = [];
  const plain = (s) => String(s);
  return {
    body,
    foot,
    sticky,
    ctx: { pluginSubPage: "libraries", cols: 120, nameW: 30, message: "", mode: "list" },
    api: {
      pushBody: (l) => body.push(l),
      pushFoot: (l) => foot.push(l),
      pushSticky: (l) => sticky.push(l),
      pad: (s) => plain(s),
      trunc: (s) => plain(s),
      BOLD: "", WHITE: "", BG_SEL: "", RST: "", GRAY: "", DIM: "",
      YELLOW: "", GREEN: "", MAGENTA: "", CYAN: "", RED: "",
      ACCENT: "", OK: "", BAD: "", INFO: "", barW: 110,
    },
  };
}

function withUpdater(reading) {
  S.UPDATER_MODULE = { homeLibraries: () => reading };
}

let previous;
beforeEach(() => {
  previous = S.UPDATER_MODULE;
});
afterEach(() => {
  S.UPDATER_MODULE = previous;
});

describe("librariesTab", () => {
  it("lists the shared store with its versions and who declares each library", () => {
    withUpdater({
      shared: [{ specifier: "@intisy-ai/core", version: "2.1.0", usedBy: ["stub-auth", "wakatime-sync"] }],
      plugins: [],
    });
    const t = collect();

    librariesTab.render(t.ctx, t.api);

    const text = t.body.join("\n") + t.sticky.join("\n");
    assert.match(text, /@intisy-ai\/core/);
    assert.match(text, /2\.1\.0/);
    assert.match(text, /stub-auth, wakatime-sync/);
    assert.match(t.sticky.join("\n"), /1 shared/);
  });

  it("groups each plugin's own dependencies under its name", () => {
    withUpdater({
      shared: [],
      plugins: [{ plugin: "wakatime-sync", dependencies: [{ specifier: "undici", version: "6.19.2", usedBy: [] }] }],
    });
    const t = collect();

    librariesTab.render(t.ctx, t.api);

    const text = t.body.join("\n");
    assert.match(text, /WAKATIME-SYNC/);
    assert.match(text, /undici/);
    assert.match(text, /6\.19\.2/);
  });

  // A library that never got written is exactly what this tab exists to surface: the
  // plugin importing it will fail to load and nothing else says why.
  it("marks a library that is declared but has no version on disk", () => {
    withUpdater({ shared: [{ specifier: "@intisy-ai/core", version: "", usedBy: ["stub-auth"] }], plugins: [] });
    const t = collect();

    librariesTab.render(t.ctx, t.api);

    assert.match(t.body.join("\n"), /missing/);
  });

  it("says a shared library nothing declares is unused", () => {
    withUpdater({ shared: [{ specifier: "@intisy-ai/core", version: "2.1.0", usedBy: [] }], plugins: [] });
    const t = collect();

    librariesTab.render(t.ctx, t.api);

    assert.match(t.body.join("\n"), /unused/);
  });

  it("points at the updater when it is not installed rather than rendering an empty tab", () => {
    S.UPDATER_MODULE = null;
    const t = collect();

    librariesTab.render(t.ctx, t.api);

    assert.match(t.body.join("\n"), /plugin-updater/);
  });

  it("says so when the home holds nothing yet", () => {
    withUpdater({ shared: [], plugins: [] });
    const t = collect();

    librariesTab.render(t.ctx, t.api);

    assert.match(t.body.join("\n"), /Nothing installed/);
  });
});
