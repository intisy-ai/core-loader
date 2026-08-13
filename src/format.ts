// @ts-nocheck
// Terminal formatting: ANSI codes and width-aware string helpers (CJK counts 2).
import { IS_CLAUDE } from "./env.js";
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

// Per-loader accent so the two loaders (sharing this core-loader TUI) each get a
// distinct palette: claude-code-loader = warm orange/tan (CC-inspired), opencode
// -loader = teal. Resolved from IS_CLAUDE (env.ts, the single app-detection source).
// Swap either constant to re-theme that loader (e.g. CC lavender "38;5;147m"). Used
// everywhere (active tab, cursor, selection title, official badge); never hardcode
// it elsewhere.
var ACCENT_CLAUDE = E + "38;5;173m";     // warm orange/tan
var ACCENT_OPENCODE = E + "38;5;73m";    // teal
export const ACCENT = IS_CLAUDE ? ACCENT_CLAUDE : ACCENT_OPENCODE;

// Muted status tones that harmonize with the accent (softer than raw ANSI 31/32/33).
export const OK = E + "38;5;108m";       // sage green, positive (auto, enabled, true, git/active)
export const BAD = E + "38;5;174m";      // dusty rose, problem (disabled, missing)
export const INFO = E + "38;5;110m";     // soft blue, secondary/info (npm method)

// Solid box-drawing divider, dim gray. Used for every full-width rule.
export function rule(width) {
  return GRAY + "─".repeat(width) + RST;
}

export function stringWidth(str) {
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

export function pad(s, len) {
  s = String(s || "");
  var w = stringWidth(s);
  var padStr = "";
  while (w < len) { padStr += " "; w++; }
  return s + padStr;
}

export function trunc(s, len) {
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

export function timeAgo(ts) {
  if (!ts) return "--";
  var d = Date.now() - ts;
  if (d < 60000) return "now";
  if (d < 3600000) return Math.floor(d / 60000) + "m ago";
  if (d < 86400000) return Math.floor(d / 3600000) + "h ago";
  return Math.floor(d / 86400000) + "d ago";
}
