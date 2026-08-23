import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLoaderCommands } from "./loader-commands.js";

let home: string;
let savedArgv: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "loader-commands-"));
  mkdirSync(join(home, "commands"), { recursive: true });
  savedArgv = process.argv;
});

afterEach(() => {
  process.argv = savedArgv;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

function commandsWith(extra: Record<string, unknown> = {}) {
  return makeLoaderCommands({
    plugin: "zeta-loader",
    commandDir: "commands",
    loaderEntry: () => "/entry/plugin.js",
    runConfigCli: () => {},
    authHint: "run `zc auth`",
    ...extra,
  });
}

describe("the settings command the loader owns", () => {
  it("is deployed beside the loader's own commands", () => {
    commandsWith().deployLoaderCommands(home);
    const written = readdirSync(join(home, "commands"));
    expect(written).toContain("config.md");

    const body = readFileSync(join(home, "commands", "config.md"), "utf8");
    expect(body).toContain('node "/entry/plugin.js" config-all $ARGUMENTS');
    expect(body).toContain("any plugin's settings");
  });

  // The point of the loader owning it: a plugin declares what its settings ARE and knows nothing
  // about how they are edited, so one command reaches every plugin.
  it("serves every plugin whose declarations the host registered", async () => {
    const dispatched: Array<{ argv: string[]; plugins: string[] }> = [];
    const engine = commandsWith({
      configTargets: () => ["alpha", "beta"],
      runAllConfigCli: (argv: string[], opts: { plugins: string[] }) => dispatched.push({ argv, plugins: opts.plugins }),
    });

    process.argv = ["node", "plugin.js", "config-all", "alpha", "set", "logging", "false"];
    expect(await engine.maybeRunCli(home)).toBe(true);
    expect(dispatched).toEqual([{ argv: ["alpha", "set", "logging", "false"], plugins: ["alpha", "beta"] }]);
  });

  it("still edits the loader's own settings through its own command", async () => {
    const edited: Array<[string, string[]]> = [];
    const engine = commandsWith({ runConfigCli: (name: string, argv: string[]) => edited.push([name, argv]) });

    process.argv = ["node", "plugin.js", "config", "list"];
    expect(await engine.maybeRunCli(home)).toBe(true);
    expect(edited).toEqual([["zeta-loader", ["list"]]]);
  });

  it("answers quietly rather than throwing when nothing serves the unified config", async () => {
    process.argv = ["node", "plugin.js", "config-all", "list"];
    await expect(commandsWith().maybeRunCli(home)).resolves.toBe(true);
  });
});
