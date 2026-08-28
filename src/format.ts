// Terminal formatting: ANSI codes and width-aware string helpers (CJK counts 2).
import { appAccent } from "./app-descriptor.js";

export const E = "\x1b[";
export const RST = E + "0m";
export const BOLD = E + "1m";
export const DIM = E + "2m";
export const GRAY = E + "90m";
export const WHITE = E + "37m";
export const YELLOW = E + "33m";
export const GREEN = E + "32m";
export const CYAN = E + "36m";
export const RED = E + "31m";
export const MAGENTA = E + "35m";
export const BG_SEL = E + "48;5;236m";
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
export const ACCENT = ansi256FromHex(appAccent()) || (E + "38;5;110m");

// Muted status tones that harmonize with the accent (softer than raw ANSI 31/32/33).
export const OK = E + "38;5;108m";       // sage green, positive (auto, enabled, true, git/active)
export const BAD = E + "38;5;174m";      // dusty rose, problem (disabled, missing)
export const INFO = E + "38;5;110m";     // soft blue, generic secondary/info tone (handed to custom-tab renderers)

// Solid box-drawing divider, dim gray. Used for every full-width rule.
export function rule(width: number): string {
  return GRAY + "─".repeat(width) + RST;
}

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

export function pad(s: string, len: number): string {
  s = String(s || "");
  var w = stringWidth(s);
  var padStr = "";
  while (w < len) { padStr += " "; w++; }
  return s + padStr;
}

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

export function timeAgo(ts: number | undefined): string {
  if (!ts) return "--";
  var d = Date.now() - ts;
  if (d < 60000) return "now";
  if (d < 3600000) return Math.floor(d / 60000) + "m ago";
  if (d < 86400000) return Math.floor(d / 3600000) + "h ago";
  return Math.floor(d / 86400000) + "d ago";
}
