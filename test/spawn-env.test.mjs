// A child process reads the trace from its ENVIRONMENT at module load, so a spawn
// site that drops the merge silently breaks the cross-process chain and nothing else.
// Two halves here: the merge really reaches a real child, and each production spawn
// site really performs it.
import { describe, it, afterEach } from "vitest";
import assert from "node:assert";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const seam = require("../dist/activity-seam.js");

describe("spawn env merge", () => {
  afterEach(() => seam.setActivitySeam(null));

  it("reaches a real child process without dropping the rest of the environment", () => {
    seam.setActivitySeam({ env: () => ({ HUB_ACTIVITY_TRACE: "trace-abc", HUB_ACTIVITY_CAUSE: '{"kind":"user"}' }) });
    const dir = mkdtempSync(join(tmpdir(), "core-loader-spawn-"));
    try {
      const script = join(dir, "child.mjs");
      writeFileSync(script, 'console.log(JSON.stringify({ trace: process.env.HUB_ACTIVITY_TRACE, cause: process.env.HUB_ACTIVITY_CAUSE, path: !!process.env.PATH }));\n');

      // the same helper every production spawn site uses
      const out = execFileSync(process.execPath, [script], { env: seam.spawnEnv() });
      const got = JSON.parse(out.toString());

      assert.strictEqual(got.trace, "trace-abc");
      assert.strictEqual(got.cause, '{"kind":"user"}');
      assert.strictEqual(got.path, true, "PATH must survive the merge");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the caller's own variables while the trace still wins", () => {
    seam.setActivitySeam({ env: () => ({ HUB_ACTIVITY_TRACE: "wins" }) });
    const merged = seam.spawnEnv({ PU_NAME: "demo", HUB_ACTIVITY_TRACE: "loses" });
    assert.strictEqual(merged.PU_NAME, "demo");
    assert.strictEqual(merged.HUB_ACTIVITY_TRACE, "wins");
    assert.ok(merged.PATH, "PATH must survive");
  });

  // These sites spawn npx, npm, and deployed bundles that no test run can
  // provide, so this is the only check that fails if someone stops routing one of
  // them through the shared helper the tests above actually cover.
  it("every site that starts a child goes through the one helper", () => {
    const sites = [
      ["src/updater.ts", 3],
      ["src/marketplace.ts", 1],
      ["src/plugins.ts", 1],
    ];
    for (const [file, expected] of sites) {
      const text = readFileSync(new URL("../" + file, import.meta.url), "utf8");
      const found = text.split("spawnEnv(").length - 1;
      assert.strictEqual(found, expected, `${file}: expected ${expected} spawn sites to use spawnEnv, found ${found}`);
      assert.ok(!text.includes("...loaderActivityEnv()"), `${file} still spreads the activity env by hand`);
    }
  });
});
