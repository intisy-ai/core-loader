// Activity page rendering: a read-only feed sourced entirely from the injected
// `S.capabilities.activity` reader (see tui.ts registerCapabilities). Renders
// whatever the host loader provides; core-loader has no app-specific logic here.

import { RST, BOLD, DIM, GRAY, WHITE, YELLOW, GREEN, RED, BG_SEL, pad, trunc, timeAgo, ACCENT, rule } from "../format.js";
import { S } from "../state.js";
import { hints, messageLine } from "./common.js";
import type { PushBody, PushFoot, PushSticky } from "./common.js";
import type { ActivityRecord } from "@intisy-ai/core";

function impactGlyph(impact: string | undefined): string {
  if (impact === "error") return RED + "x" + RST;
  if (impact === "warning") return YELLOW + "!" + RST;
  if (impact === "notice") return GREEN + "❯" + RST;
  if (impact === "debug") return GRAY + "." + RST;
  return DIM + "-" + RST;   // info (default)
}

/** Draws the Activity page. */
export function buildActivity(pushBody: PushBody, pushFoot: PushFoot, cols: number, barW: number, pushSticky: PushSticky): void {
  var readFn = S.capabilities && S.capabilities.activity && S.capabilities.activity.read;
  var impacts = S.activityImpacts || [];
  var filterNote = impacts.length ? GRAY + " [" + impacts.join(",") + "]" + RST : "";
  pushSticky("  " + BOLD + WHITE + "Activity" + RST + GRAY + " (" + (S.activityRecords || []).length + ")" + RST + filterNote);
  pushSticky("");

  if (typeof readFn !== "function") {
    pushBody("  " + GRAY + "Activity unavailable." + RST, false);
    pushBody("", false);
    pushFoot("  " + rule(barW));
    pushFoot(hints([["q", "quit"]]));
    return;
  }

  var records = (S.activityRecords || []).slice().sort(function(a, b) { return (b.ts || 0) - (a.ts || 0); });
  if (records.length === 0) {
    pushBody("  " + GRAY + "No activity yet." + RST, false);
    pushBody("", false);
    pushFoot("  " + rule(barW));
    pushFoot(hints([["r", "refresh"], ["q", "quit"]]));
    return;
  }

  var tsW = 8;
  var srcW = Math.min(20, Math.max(10, cols - 40));
  // The app and cause columns are worth less than a readable message, so a narrow
  // terminal drops them rather than truncating the text into uselessness.
  var wide = cols >= 100;
  var whereW = wide ? 12 : 0;
  var whyW = wide ? 8 : 0;
  var textW = Math.max(10, cols - 20 - tsW - srcW - (whereW ? whereW + 1 : 0) - (whyW ? whyW + 1 : 0));
  for (var i = 0; i < records.length; i++) {
    var rec = records[i] || ({} as ActivityRecord);
    var sel = i === S.activityCursor;
    var arrow = sel ? (ACCENT + " ❯ " + RST) : "   ";
    var bg = sel ? BG_SEL : "";
    var srcStyle = sel ? (BOLD + WHITE) : DIM;
    var textStyle = sel ? WHITE : GRAY;
    var where = (rec.origin && rec.origin.app) || "";
    var why = (rec.cause && rec.cause.kind) || "";
    pushBody(
      "  " + bg + arrow + impactGlyph(rec.impact) + " " + GRAY + pad(timeAgo(rec.ts), tsW) + RST +
      bg + " " + srcStyle + pad(trunc(String(rec.source || ""), srcW), srcW) + RST +
      (whereW ? bg + " " + DIM + pad(trunc(String(where), whereW), whereW) + RST : "") +
      (whyW ? bg + " " + DIM + pad(trunc(String(why), whyW), whyW) + RST : "") +
      bg + "  " + textStyle + trunc(String(rec.text || ""), textW) + RST,
      sel
    );
  }
  pushBody("", false);
  if (S.message) {
    pushFoot(messageLine(cols));
  }
  pushFoot("  " + rule(barW));
  pushFoot(hints([["↑↓", "move"], ["i", "impact"], ["r", "refresh"], ["q", "quit"]]));
}
