// A settings action may declare what it needs collected before it runs. These drive the editor the
// way a person does, because the bug this covers was not in the call but in the keystrokes: the
// action ran with nothing collected, so a plugin asked to create a profile got no name.
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { startPlugins } from "@intisy-ai/api/host";
import { resetPluginHostForTests, runSettingsAction } from "./plugin-surface.js";
import { PLUGINS_DIR } from "./env.js";
import { S } from "./state.js";
import { handleConfigActionArgsData, handleSettingsKey } from "./input.js";

type Run = { actionId: string; input: Record<string, unknown> | undefined };

function runtime() {
  return {
    config: { all: () => ({}), get: () => undefined, set: async () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    paths: { home: PLUGINS_DIR, repos: PLUGINS_DIR, plugin: PLUGINS_DIR, cache: PLUGINS_DIR, config: PLUGINS_DIR },
    events: { publish: () => {}, subscribe: () => () => {} },
  };
}

async function hostRecording(runs: Run[]) {
  const entryPath = join(PLUGINS_DIR, "demo.js");
  const loaded = await startPlugins({
    app: "test",
    pluginDir: PLUGINS_DIR,
    surfaces: ["tui"],
    runtimeFor: () => runtime() as never,
    scan: {
      loaded: [{
        manifest: { id: "demo", api: 1, entry: "dist/index.js", capabilities: ["settings"] },
        manifestPath: join(PLUGINS_DIR, "demo.json"),
        entryPath,
      }],
      failed: [],
    },
    importEntry: async () => ({
      default: {
        activate: (ctx: { provide: (id: string, value: unknown) => void }) =>
          ctx.provide("settings", {
            schema: () => ({}),
            run: async (actionId: string, input?: Record<string, unknown>) => {
              runs.push({ actionId, input });
              return { ok: true, message: "ran" };
            },
          }),
        deactivate: () => {},
      },
    }),
  });
  resetPluginHostForTests(loaded);
  return loaded;
}

function type(text: string) {
  for (const char of text) handleConfigActionArgsData(Buffer.from(char));
}

const ENTER = Buffer.from([13]);
const ESC = Buffer.from([27]);

function openEditor(rows: unknown[]) {
  S.page = "settings";
  S.mode = "pconfig";
  S.configItems = rows;
  S.configTarget = { name: "demo", plugin: "demo", bundle: "/does-not-exist.js", file: "demo.json", items: rows };
  S.cfgcursor = 0;
  S.configConfirm = null;
  S.configActionArgs = null;
  S.inputBuf = "";
}

const CREATE = {
  kind: "action", key: "profileCreate", label: "Create",
  args: [{ key: "name", type: "string", label: "Profile name" }],
};

afterEach(() => {
  S.mode = "list";
  S.configItems = [];
  S.configTarget = null;
  S.configActionArgs = null;
  S.inputBuf = "";
  resetPluginHostForTests(null);
});

describe("an action that declares args", () => {
  it("prompts instead of running, then runs with what was collected", async () => {
    const runs: Run[] = [];
    await hostRecording(runs);
    openEditor([CREATE]);

    handleSettingsKey("enter");
    expect(S.mode).toBe("pcfgargs");
    expect(runs).toEqual([]);

    type("my-profile");
    handleConfigActionArgsData(ENTER);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(S.mode).toBe("pconfig");
    expect(runs).toEqual([{ actionId: "profileCreate", input: { name: "my-profile" } }]);
  });

  it("collects every arg before running, in declaration order", async () => {
    const runs: Run[] = [];
    await hostRecording(runs);
    openEditor([{
      kind: "action", key: "commit", label: "Snapshot",
      args: [{ key: "reason", type: "string", label: "Note" }, { key: "tag", type: "string", label: "Tag" }],
    }]);

    handleSettingsKey("enter");
    type("first release");
    handleConfigActionArgsData(ENTER);
    expect(runs).toEqual([]);
    expect(S.mode).toBe("pcfgargs");

    type("v1");
    handleConfigActionArgsData(ENTER);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runs).toEqual([{ actionId: "commit", input: { reason: "first release", tag: "v1" } }]);
  });

  // Half an action's args is not an action the plugin declared, so escape abandons all of them.
  it("abandons the whole action on escape, mid-collection", async () => {
    const runs: Run[] = [];
    await hostRecording(runs);
    openEditor([{
      kind: "action", key: "commit", label: "Snapshot",
      args: [{ key: "reason", type: "string", label: "Note" }, { key: "tag", type: "string", label: "Tag" }],
    }]);

    handleSettingsKey("enter");
    type("half typed");
    handleConfigActionArgsData(ENTER);
    handleConfigActionArgsData(ESC);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(S.mode).toBe("pconfig");
    expect(S.configActionArgs).toBeNull();
    expect(runs).toEqual([]);
  });

  it("edits the value being typed, backspace and all", async () => {
    const runs: Run[] = [];
    await hostRecording(runs);
    openEditor([CREATE]);

    handleSettingsKey("enter");
    type("mainx");
    handleConfigActionArgsData(Buffer.from([127]));
    handleConfigActionArgsData(ENTER);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runs).toEqual([{ actionId: "profileCreate", input: { name: "main" } }]);
  });
});

describe("an action that declares none", () => {
  it("runs straight away, and is called the way it declares itself", async () => {
    const runs: Run[] = [];
    await hostRecording(runs);
    openEditor([{ kind: "action", key: "profileSwitch", label: "Switch" }]);

    handleSettingsKey("enter");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(S.mode).toBe("pconfig");
    expect(runs).toEqual([{ actionId: "profileSwitch", input: undefined }]);
  });

  // The seam itself, since a surface that has nothing to pass must not pass an empty object: a
  // plugin reading `input.name` on the two-argument overload would see one where it declared none.
  it("passes no input at all when the caller has none", async () => {
    const runs: Run[] = [];
    await hostRecording(runs);
    expect(await runSettingsAction("demo", "bare")).toEqual({ ok: true, message: "ran" });
    expect(runs).toEqual([{ actionId: "bare", input: undefined }]);
  });
});
