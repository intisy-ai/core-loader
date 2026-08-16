import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// A core library serves every app and may name none of them. Comments are stripped before the
// scan: a comment naming a model family or a consuming repo is legitimate and unavoidable, and a
// guard needing an allowlist that long would hide a real branch inside it, which is how a name
// branch survived in a sibling library. Strings in code ARE scanned; that is where the app-config
// filenames lived.
const APP_TERMS = ["claude", "opencode"];

// Only file-scoped exemptions, each naming something that is not this app's identity:
//   src/catalogs.ts  third-party catalog data. Every name in it is a SOURCE (someone else's
//                    repository, package or published file format), exactly as `github-org:
//                    intisy-ai` is a source and not a plugin name.
const ALLOWED = new Set(["src/catalogs.ts"]);

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return found; }
  for (const name of names) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { found.push(...sourceFiles(path)); continue; }
    if (name.endsWith(".test.ts") || name.endsWith(".test.mjs")) continue;
    if (name.endsWith(".ts") || name.endsWith(".js")) found.push(path);
  }
  return found;
}

function relativeTo(file: string): string {
  return file.slice(repoRoot.length + 1).replace(/\\/g, "/");
}

export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/([^:"'`\\])\/\/.*$/gm, "$1");
}

// An identity compared to a literal encodes the arity as well as the name: it says there are
// exactly these apps. Banned wherever it appears, allowlist or not.
const IDENTITY_COMPARISON = /\b(APP_ID|APP_NAME|CLI_CMD|appId|activeAppId\(\)|getApp\(\)|currentAppId\(\))\s*(===|!==|==|!=)\s*["'`]/;

describe("core names no app", () => {
  const files = sourceFiles(join(repoRoot, "src"));

  it("found the files to guard", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  for (const file of files) {
    const relative = relativeTo(file);
    it(`${relative} names no app in code`, () => {
      if (ALLOWED.has(relative)) return;
      const code = stripComments(readFileSync(file, "utf8")).toLowerCase();
      expect(APP_TERMS.filter((term) => code.includes(term))).toEqual([]);
    });
  }

  for (const file of files) {
    const relative = relativeTo(file);
    it(`${relative} compares no app identity to a literal`, () => {
      const offenders: string[] = [];
      stripComments(readFileSync(file, "utf8")).split("\n").forEach((line, index) => {
        if (IDENTITY_COMPARISON.test(line)) offenders.push(`${relative}:${index + 1}`);
      });
      expect(offenders).toEqual([]);
    });
  }
});
