import { describe, it } from "vitest";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// The CLI is a separate process, so this runs it exactly as the cc/oc wrapper does. It is also the
// only check that `doctor` does not throw: cli.ts is @ts-nocheck'd and used APP_NAME without
// importing it. fileURLToPath (not the URL's raw .pathname) is what turns the file:// URL into a
// path node accepts on every platform, including Windows drive letters.
const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function runCli(args) {
  const home = mkdtempSync(join(tmpdir(), "core-loader-cli-"));
  return execFileSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env, HUB_CONFIG_DIR: home },
  });
}

describe("cc|oc doctor", () => {
  it("runs to completion and reports the plugin manager rather than npx", () => {
    const out = runCli(["doctor"]);
    assert.match(out, /plugin manager/);
    assert.doesNotMatch(out, /npx/);
  });
});

describe("cc|oc plugins update", () => {
  it("exits non-zero and names no plugin when no manager is installed", () => {
    let failed = false;
    try { runCli(["plugins", "update"]); } catch (error) { failed = true; assert.match(String(error.stderr || ""), /plugin-management/); }
    assert.ok(failed, "plugins update must fail when nothing manages plugins");
  });
});
