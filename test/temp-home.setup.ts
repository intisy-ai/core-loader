// Every test file runs against a temp home, pinned here so no test file has to remember. env.ts
// resolves CONFIG_DIR from HUB_CONFIG_DIR at import time and tuiLog appends a log file under it, so
// a file that reaches a logger, a config read or a plugin scan without pinning first reads and
// writes the developer's real ~/.config/opencode. Setup files run before a test file is loaded, so
// a file needing its own home (env.test.mjs, views/settings.test.ts) still overrides this. A module
// reaching the app registry without the HUB_APPS_FILE pin below reads the developer's real
// ~/.config/cairn/apps.json.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const home = mkdtempSync(join(tmpdir(), "core-loader-suite-home-"));
process.env.HUB_CONFIG_DIR = home;
writeFileSync(join(home, "apps.json"), "{}");
process.env.HUB_APPS_FILE = join(home, "apps.json");

afterAll(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});
