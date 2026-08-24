// With no plugin managing plugins, both plugin surfaces gate to one instruction the OPERATOR runs.
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { S } = require("../dist/state.js");
const { buildPlugins } = require("../dist/views/plugins.js");

const STRIP = /\[[0-9;]*m/g;

function render() {
  const body = [];
  const foot = [];
  buildPlugins((line) => body.push(String(line).replace(STRIP, "")), (line) => foot.push(String(line).replace(STRIP, "")), 120, 110, () => {});
  return { body: body.join("\n"), foot: foot.join("\n") };
}

beforeEach(() => {
  S.hasUpdater = false;
  S.UPDATER_MODULE = null;
  S.pluginSubPage = "installed";
  S.mode = "list";
  S.pluginItems = [];
});

afterEach(() => {
  S.hasUpdater = false;
  S.pluginManager = undefined;
  S.globalKeyHandler = null;
});

describe("the plugin-manager gate", () => {
  it("says nothing manages plugins and names no plugin when none resolved", () => {
    S.pluginManager = null;
    const { body, foot } = render();
    assert.match(body, /No plugin manager installed/);
    assert.match(body, /plugin-management/);
    assert.match(body, /marketplaces\.json/);
    assert.doesNotMatch(body, /plugin-updater/);
    assert.match(foot, /re-check/);
    assert.equal(S.globalKeyHandler, "manager_recheck");
  });

  it("shows the resolved manager's own install command for the operator to run", () => {
    S.pluginManager = { id: "demo-manager", npmName: "@demo/manager", source: "catalog" };
    const { body } = render();
    assert.match(body, /@demo\/manager@latest init --app/);
  });

  it("renders the list once a manager is loadable", () => {
    S.hasUpdater = true;
    S.pluginManager = { id: "demo-manager", npmName: "demo-manager", source: "deployed" };
    const { body } = render();
    assert.doesNotMatch(body, /No plugin manager installed/);
    assert.notEqual(S.globalKeyHandler, "manager_recheck");
  });
});
