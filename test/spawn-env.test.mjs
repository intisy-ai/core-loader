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

      // the same expression every production spawn site uses
      const out = execFileSync(process.execPath, [script], { env: { ...process.env, ...seam.loaderActivityEnv() } });
      const got = JSON.parse(out.toString());

      assert.strictEqual(got.trace, "trace-abc");
      assert.strictEqual(got.cause, '{"kind":"user"}');
      assert.strictEqual(got.path, true, "PATH must survive the merge");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A source-level assertion is normally a smell, but these five sites spawn npx,
  // npm, and deployed bundles that are not available in a test run, so this is the
  // only check that fails when someone deletes the merge from one of them.
  it("is present at every site that starts a child", () => {
    const sites = [
      ["src/updater.ts", 3],
      ["src/marketplace.ts", 1],
      ["src/plugins.ts", 1],
    ];
    for (const [file, expected] of sites) {
      const text = readFileSync(new URL("../" + file, import.meta.url), "utf8");
      const found = text.split("loaderActivityEnv()").length - 1;
      assert.strictEqual(found, expected, `${file}: expected ${expected} spawn sites to merge the activity env, found ${found}`);
    }
  });
});
