// Terminal output: buffered writes to stderr and cursor visibility.

import { E } from "./format.js";

/** Hides the terminal cursor. */
export function hideCur() { process.stderr.write(E + "?25l"); }
/** Shows it again. */
export function showCur() { process.stderr.write(E + "?25h"); }

/** Restore the terminal: show cursor, clear screen, leave raw mode. */
export function cleanup() {
  showCur();
  process.stderr.write(E + "H" + E + "2J");
  try { process.stdin.setRawMode(false); } catch {}
}
