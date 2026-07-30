import { describe, it } from "vitest";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureNotifyDrainHook } from "../dist/notify.js";

describe("ensureNotifyDrainHook", () => {
  it("registers Stop + PostToolUse hooks that run the loader's bus-drain action", () => {
    const configDir = mkdtempSync(join(tmpdir(), "core-loader-notify-"));
    const loaderEntry = join(configDir, "repos", "the-loader", "dist", "plugin.js");

    ensureNotifyDrainHook(configDir, loaderEntry);

    const settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
    const expected = `node "${loaderEntry}" bus-drain`;
    for (const evt of ["Stop", "PostToolUse"]) {
      const cmds = settings.hooks[evt].flatMap((e) => e.hooks.map((h) => h.command));
      assert.ok(cmds.includes(expected), `${evt} should run bus-drain`);
    }
  });

  it("is idempotent and replaces a retired auth-notify-drain hook rather than stacking", () => {
    const configDir = mkdtempSync(join(tmpdir(), "core-loader-notify-"));
    const loaderEntry = join(configDir, "repos", "the-loader", "dist", "plugin.js");
    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node "${join(configDir, "cache", "auth-notify-drain.cjs")}"` }] }] } }),
    );

    ensureNotifyDrainHook(configDir, loaderEntry);
    ensureNotifyDrainHook(configDir, loaderEntry);

    const settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
    const stopCmds = settings.hooks.Stop.flatMap((e) => e.hooks.map((h) => h.command));
    assert.deepEqual(stopCmds, [`node "${loaderEntry}" bus-drain`]);
  });

  it("removes the retired read-truncate queue and generated drain script", () => {
    const configDir = mkdtempSync(join(tmpdir(), "core-loader-notify-"));
    mkdirSync(join(configDir, "cache"), { recursive: true });
    const queue = join(configDir, "cache", "auth-notifications.jsonl");
    const script = join(configDir, "cache", "auth-notify-drain.cjs");
    writeFileSync(queue, "{}\n");
    writeFileSync(script, "// old");

    ensureNotifyDrainHook(configDir, join(configDir, "repos", "the-loader", "dist", "plugin.js"));

    assert.ok(!existsSync(queue), "retired queue should be deleted");
    assert.ok(!existsSync(script), "retired drain script should be deleted");
  });
});
