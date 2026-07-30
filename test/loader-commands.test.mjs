import { describe, it, afterEach } from "vitest";
import assert from "node:assert";
import { makeLoaderCommands } from "../dist/loader-commands.js";

const realArgv = process.argv;
afterEach(() => { process.argv = realArgv; });

function commandsWith(overrides = {}) {
  return makeLoaderCommands({
    plugin: "the-loader",
    commandDir: "commands",
    loaderEntry: () => "/entry/plugin.js",
    runConfigCli: () => {},
    authHint: "run auth",
    ...overrides,
  });
}

describe("makeLoaderCommands bus-drain", () => {
  it("runs the injected busDrain and reports the action as handled", async () => {
    let drained = 0;
    const { maybeRunCli } = commandsWith({ busDrain: () => { drained++; } });
    process.argv = ["node", "plugin.js", "bus-drain"];
    assert.equal(await maybeRunCli("/cfg"), true);
    assert.equal(drained, 1);
  });

  it("still reports bus-drain handled when no busDrain is injected", async () => {
    const { maybeRunCli } = commandsWith();
    process.argv = ["node", "plugin.js", "bus-drain"];
    assert.equal(await maybeRunCli("/cfg"), true);
  });

  it("leaves unrelated actions unhandled", async () => {
    const { maybeRunCli } = commandsWith({ busDrain: () => {} });
    process.argv = ["node", "plugin.js", "something-else"];
    assert.equal(await maybeRunCli("/cfg"), false);
  });
});
