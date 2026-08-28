// Reading a JSON file that may be absent, empty or malformed, which is every config file a
// loader touches. Each caller says what an unreadable file should read as, because the useful
// answer differs: a missing plugin list is [], a missing settings object is {}, and a missing
// package.json is nothing at all.

import { readFileSync } from "fs";

/** One JSON file's contents, or the caller's fallback when it is absent, empty or malformed. */
export function readJson<T = unknown>(file: string, fallback: T | null = null): T | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/**
 * Some app configs carry // comments, which JSON.parse rejects. Stripping
 * whole-line comments only, so a // inside a string value survives.
 */
export function readJsonc<T = unknown>(file: string, fallback: T | null = null): T | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\s*\/\/[^\n]*/gm, ""));
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}
