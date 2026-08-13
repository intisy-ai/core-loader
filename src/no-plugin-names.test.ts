import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The whole rework exists to remove these. A library may name a SOURCE (an org) but never a plugin,
// in any file format, so this scans data and markdown as well as code. Test files are excluded
// because they legitimately use real names as fixture data, exactly as core's own guard test does.
const FORBIDDEN = ["plugin-updater", "config-ledger", "sync-bridge", "custom-auth"];

// data/ is excluded until part 5 deletes data/official-plugins.json, which still lists two of these
// as installable plugins. Part 5 widens this list.
const ROOTS = ["src"];

// Every root markdown file, not just README.md: a fixed name list repeats the exact failure shape
// (a stale root file the guard never scanned) that is the reason this guard scans the root at all.
function rootMarkdownFiles(repoRoot: string): string[] {
  return readdirSync(repoRoot)
    .filter((name) => statSync(join(repoRoot, name)).isFile() && name.endsWith(".md"))
    .map((name) => join(repoRoot, name));
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (name.endsWith(".test.ts") || name.endsWith(".test.mjs")) continue;
    if (name.endsWith(".ts") || name.endsWith(".js") || name.endsWith(".json") || name.endsWith(".md")) found.push(path);
  }
  return found;
}

// fileURLToPath, not new URL().pathname: on Windows the latter yields a leading-slash path that
// doubles the drive letter when joined.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("the loader names no plugin", () => {
  const files = [
    ...ROOTS.flatMap((root) => sourceFiles(join(repoRoot, root))),
    ...rootMarkdownFiles(repoRoot),
  ];

  it("found the files to guard", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  for (const file of files) {
    it(`${file.slice(repoRoot.length)} names no plugin`, () => {
      const text = readFileSync(file, "utf8").toLowerCase();
      expect(FORBIDDEN.filter((name) => text.includes(name))).toEqual([]);
    });
  }
});

// The rule is that this library never STARTS a child process running npx, because npx always fetches
// the published package whatever the home installed. Naming it in a comment is fine, so is offering
// it as text for an operator to run, and so is the MCP server catalog, whose `command: "npx"` entries
// are commands the user's own MCP client runs.
const CHILD_STARTERS = /\b(exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(/;

describe("the loader never runs npx", () => {
  it("no line both starts a child process and names npx", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(repoRoot, "src"))) {
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (CHILD_STARTERS.test(line) && line.includes("npx")) {
          offenders.push(`${file.slice(repoRoot.length).replace(/\\/g, "/")}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
