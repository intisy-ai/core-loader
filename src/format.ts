// Terminal formatting: ANSI codes and width-aware string helpers (CJK counts 2).
import { appAccent } from "./app-descriptor.js";

/** The escape sequence every code below is built on. */
export const E = "\x1b[";
/** Resets every attribute. */
export const RST = E + "0m";
/** Bold. */
export const BOLD = E + "1m";
/** Dim, which is what an ordinary unselected row is drawn in. */
export const DIM = E + "2m";
/** Gray, for secondary text. */
export const GRAY = E + "90m";
/** White, which with bold marks the selected row. */
export const WHITE = E + "37m";
/** Yellow, for a caution. */
export const YELLOW = E + "33m";
/** Green. */
export const GREEN = E + "32m";
/** Cyan. */
export const CYAN = E + "36m";
/** Red, for a failure. */
export const RED = E + "31m";
/** Magenta. */
export const MAGENTA = E + "35m";
/** The selected row's background. */
export const BG_SEL = E + "48;5;236m";
/** Clears to the end of the line. */
export const CLR = E + "K";

/**
 * A `#rrggbb` colour as an ANSI 256 foreground code, or "" when it is not a colour.
 *
 * @remarks
 * The 6x6x6 cube is the widest palette a terminal reliably renders, and an app declares a hex
 * colour because that is the one form both a terminal and a dashboard can use.
 */
export function ansi256FromHex(hex: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!match) return "";
  const value = parseInt(match[1], 16);
  const levels = [0, 95, 135, 175, 215, 255];
  const nearest = (channel: number) => {
    let best = 0;
    for (var i = 1; i < levels.length; i++) {
      if (Math.abs(levels[i] - channel) < Math.abs(levels[best] - channel)) best = i;
    }
    return best;
  };
  const index = 16 + 36 * nearest((value >> 16) & 255) + 6 * nearest((value >> 8) & 255) + nearest(value & 255);
  return E + "38;5;" + index + "m";
}

// The app's own accent, so the loader takes the colour of whatever it is loading. An app that
// declares none gets the neutral secondary tone rather than another app's colour.
/** The active app's own accent colour, falling back to a neutral blue when it declares none. */
export const ACCENT = ansi256FromHex(appAccent()) || (E + "38;5;110m");

// Muted status tones that harmonize with the accent (softer than raw ANSI 31/32/33).
/** Sage green, for a positive state: enabled, automatic, true, active. */
export const OK = E + "38;5;108m";
/** Dusty rose, for a problem: disabled, or missing. */
export const BAD = E + "38;5;174m";
/** Soft blue, the generic secondary tone, handed to a contributed tab so its rows match. */
export const INFO = E + "38;5;110m";

// Solid box-drawing divider, dim gray. Used for every full-width rule.
/**
 * A full-width divider.
 *
 * @param width how many characters wide.
 * @returns the line, already dimmed.
 */
export function rule(width: number): string {
  return GRAY + "─".repeat(width) + RST;
}

/**
 * How many terminal columns a string occupies.
 *
 * @remarks
 * ANSI codes are stripped first and a CJK codepoint counts as two, so a row of East Asian text
 * lines up with a row of Latin text instead of overrunning its column by its own length again.
 *
 * @param str the text to measure.
 * @returns its width in columns.
 */
export function stringWidth(str: string): number {
  var w = 0;
  str = String(str || "").replace(/\x1b\[[0-9;]*m/g, "");
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c >= 0x1100 && c <= 0xD7AF || c >= 0x3040 && c <= 0x313F || c >= 0xF900 && c <= 0xFAFF || c >= 0xFF00 && c <= 0xFFEF) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/**
 * Pads text to a column width, measured in terminal columns rather than characters.
 *
 * @param s the text.
 * @param len the column width.
 * @returns the text with trailing spaces.
 */
export function pad(s: string, len: number): string {
  s = String(s || "");
  var w = stringWidth(s);
  var padStr = "";
  while (w < len) { padStr += " "; w++; }
  return s + padStr;
}

/**
 * Truncates text to a column width, measured in terminal columns rather than characters.
 *
 * @param s the text.
 * @param len the column width.
 * @returns the text, shortened if it did not fit.
 */
export function trunc(s: string, len: number): string {
  s = String(s || "");
  if (stringWidth(s) <= len) return s;
  var res = "";
  var w = 0;
  for (var i = 0; i < s.length; i++) {
    var cw = stringWidth(s[i]);
    if (w + cw > len - 3) break;
    w += cw;
    res += s[i];
  }
  return res + "...";
}

/** Renders a secret as a fixed-width mask, so its length is not leaked by the display. */
export function secretMask(value: unknown): string {
  return (value === undefined || value === null || value === "") ? "(unset)" : "••••••••";
}

/**
 * Renders a secret being typed as one dot per character.
 *
 * @remarks
 * Deliberately not {@link secretMask}'s fixed width: while typing, a growing line is the only
 * feedback that a keystroke or a pasted token landed at all. No stored length leaks either way,
 * because the editor opens a secret row with an empty buffer, so this only ever measures what was
 * just typed. What was saved is checked afterwards with the row's own reveal.
 */
export function entryMask(text: string): string {
  return "•".repeat(text.length);
}

/**
 * Whether a row declared `boolean` is on.
 *
 * @remarks
 * Accepts the string `"true"` alongside the real boolean so a value that drifted from its
 * declaration (a hand-edited config on disk) still reads as off rather than trusting the
 * truthiness of any non-empty string.
 */
export function isBooleanRowOn(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * How long ago a timestamp was, in the shortest form that still says it.
 *
 * @param ts the moment, in epoch milliseconds.
 * @returns a phrase such as "now" or "3d ago", or "--" when there is no timestamp.
 */
export function timeAgo(ts: number | undefined): string {
  if (!ts) return "--";
  var d = Date.now() - ts;
  if (d < 60000) return "now";
  if (d < 3600000) return Math.floor(d / 60000) + "m ago";
  if (d < 86400000) return Math.floor(d / 3600000) + "h ago";
  return Math.floor(d / 86400000) + "d ago";
}
