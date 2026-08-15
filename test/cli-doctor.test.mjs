import { describe, it } from "vitest";
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// The CLI is a separate process, so this runs it exactly as the cc/oc wrapper does. It is also the
// only check that `doctor` does not throw: cli.ts is @ts-nocheck'd and used APP_NAME without
// importing it. fileURLToPath (not the URL's raw .pathname) is what turns the file:// URL into a
// path node accepts on every platform, including Windows drive letters.
const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function runCli(args, extraEnv) {
  const home = mkdtempSync(join(tmpdir(), "core-loader-cli-"));
  return execFileSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env, HUB_CONFIG_DIR: home, ...extraEnv },
  });
}

function runCliAsApp(descriptor) {
  const home = mkdtempSync(join(tmpdir(), "core-loader-cli-app-"));
  const appsFile = join(home, "apps.json");
  writeFileSync(appsFile, JSON.stringify({ zeta: { id: "zeta", label: "Zeta", home: { candidates: [home] }, ...descriptor } }));
  return execFileSync(process.execPath, [CLI_PATH], {
    encoding: "utf8",
    env: { ...process.env, HUB_CONFIG_DIR: home, HUB_APPS_FILE: appsFile, HUB_APP_ID: "zeta", HUB_CLI_CMD: "" },
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

describe("the usage line names the command a user actually types", () => {
  it("uses the app's declared wrapper command over its own binary name", () => {
    const out = runCliAsApp({ detect: { binary: "zetabin" }, wrapperCommand: "zc" });
    assert.match(out, /usage: zc /);
    assert.doesNotMatch(out, /usage: zetabin /);
  });

  it("falls back to the app's own binary when it declares no wrapper command", () => {
    const out = runCliAsApp({ detect: { binary: "zetabin" } });
    assert.match(out, /usage: zetabin /);
  });
});
