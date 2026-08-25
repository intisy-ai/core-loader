import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The whole rework exists to remove these. A library may name a SOURCE (an org) but never a plugin,
// in any file format, so this scans data and markdown as well as code. Test files are excluded
// because they legitimately use real names as fixture data, exactly as core's own guard test does.
const FORBIDDEN = ["plugin-updater", "config-ledger", "sync-bridge", "custom-auth", "claude-code-loader", "opencode-loader"];

// data/ is scanned so a JSON catalog can never reintroduce a plugin name behind the guard that
// exists to catch exactly that. The directory may be absent, which is not a failure.
const ROOTS = ["src", "data"];

// Every root markdown and json file, not just README.md: a fixed name list repeats the exact failure
// shape (a stale root file the guard never scanned) that is the reason this guard scans the root at
// all. Root only, since anything deeper is either a scanned source root or a dependency.
const ROOT_FILES = /\.(md|json)$/;

function rootFiles(repoRoot: string): string[] {
  return readdirSync(repoRoot)
    .filter((name) => ROOT_FILES.test(name) && statSync(join(repoRoot, name)).isFile())
    .map((name) => join(repoRoot, name));
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of names) {
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

function relativeTo(repoRoot: string, file: string): string {
  return file.slice(repoRoot.length + 1).replace(/\\/g, "/");
}

// The rule bans a host BRANCHING on a plugin id, not naming one: a comment or a document may say
// which plugin something is for. Each entry excuses only the names listed against it, so a
// different forbidden name in that same file still fails.
const PROSE_ALLOWED: Record<string, string[]> = {
  "src/format.ts": ["claude-code-loader"],
  "src/loader-runtime.ts": ["claude-code-loader", "opencode-loader"],
  "src/proxy-runner.ts": ["claude-code-loader", "opencode-loader"],
  // CONTENT.md is the README's source, generated into README.md on the default branch, so the two
  // carry the same prose and earn the same allowance.
  "CONTENT.md": ["claude-code-loader", "opencode-loader"],
  "README.md": ["claude-code-loader", "opencode-loader"],
  "SPEC.md": ["opencode-loader"],
};

const PLUGIN_NAME_ALLOWED: Record<string, string[]> = PROSE_ALLOWED;

describe("the loader names no plugin", () => {
  const files = [
    ...ROOTS.flatMap((root) => sourceFiles(join(repoRoot, root))),
    ...rootFiles(repoRoot),
  ];

  it("found the files to guard", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  for (const file of files) {
    const excused = PLUGIN_NAME_ALLOWED[relativeTo(repoRoot, file)] || [];
    it(`${file.slice(repoRoot.length)} names no plugin`, () => {
      const text = readFileSync(file, "utf8").toLowerCase();
      expect(FORBIDDEN.filter((name) => text.includes(name) && !excused.includes(name))).toEqual([]);
    });
  }
});

// The rule is that this library never STARTS a child process running npx, because npx always fetches
// the published package whatever the home installed. Naming it in a comment is fine, so is offering
// it as text for an operator to run, and so is the MCP server catalog, whose `command: "npx"` entries
// are commands the user's own MCP client runs.
const CHILD_STARTERS = /\b(exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(/;

// The line-scoped check above cannot see the shape this rule was written for: a command built into a
// variable on one line and spawned on another. So an npx command STRING is banned too, everywhere
// except three files that legitimately hold one.
//   src/plugin-manager.ts  builds the bootstrap command as text for an OPERATOR to run.
//   src/catalogs.ts        the MCP server catalog, whose `command: "npx"` entries are commands the
//   src/marketplace.ts     user's own MCP client runs, never this library.
const NPX_STRING_ALLOWED = ["src/plugin-manager.ts", "src/catalogs.ts", "src/marketplace.ts"];
const NPX_STRING = /["'`]npx/;

describe("the loader never runs npx", () => {
  it("no line both starts a child process and names npx", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(repoRoot, "src"))) {
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (CHILD_STARTERS.test(line) && line.includes("npx")) {
          offenders.push(`${relativeTo(repoRoot, file)}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("no file outside the allowlist holds an npx command string", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(repoRoot, "src"))) {
      const relative = relativeTo(repoRoot, file);
      if (NPX_STRING_ALLOWED.includes(relative)) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (NPX_STRING.test(line)) offenders.push(`${relative}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
