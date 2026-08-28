// Bridge for auth-provider notifications. The proxy publishes user notifications onto
// core's shared event bus; this registers a PostToolUse + Stop hook that runs the
// loader's `bus-drain` action, which drains the bus and hands each message to the
// app's own notification surface (shown to the USER, never added to the model's
// context).

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { readJson } from "./json.js";
import { join } from "path";

/** The part of an app's `settings.json` this bridge touches: its hook table, by event name. */
interface AppSettings {
  /** Each event's registered hooks, exactly as the app wrote them. */
  hooks?: Record<string, unknown[]>;
}

/**
 * Registers the drain hooks pointing at `node "<loaderEntry>" bus-drain`, and clears
 * out the retired read-truncate queue artifacts. Idempotent. loaderEntry is the
 * absolute path to the loader's runtime plugin.js (which handles the bus-drain CLI).
 */
export function ensureNotifyDrainHook(configDir: string, loaderEntry: string): void {
  try {
    const settingsPath = join(configDir, "settings.json");
    const settings = readJson<AppSettings>(settingsPath, {}) ?? {};
    const hooks = settings.hooks || (settings.hooks = {});
    const cmd = `node "${loaderEntry}" bus-drain`;
    // Drain on BOTH Stop (end of every turn, surfaces notifications even when no tool
    // ran, e.g. a plain answer) and PostToolUse (mid-turn, during long tool sequences).
    // Drop any prior drain entry (current bus-drain or the retired auth-notify-drain).
    let changed = false;
    for (const evt of ["Stop", "PostToolUse"]) {
      const list = hooks[evt] || (hooks[evt] = []);
      const kept = list.filter((entry: unknown) => {
        const s = JSON.stringify(entry);
        return !s.includes("bus-drain") && !s.includes("auth-notify-drain");
      });
      kept.push({ hooks: [{ type: "command", command: cmd }] });
      if (JSON.stringify(kept) !== JSON.stringify(list)) { hooks[evt] = kept; changed = true; }
    }
    if (changed) writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

    // Remove the retired generated drain script + read-truncate queue (both homes).
    for (const stale of [
      join(configDir, "cache", "auth-notify-drain.cjs"),
      join(configDir, "cache", "auth-notifications.jsonl"),
      join(configDir, "config", "auth-notify-drain.cjs"),
      join(configDir, "config", "auth-notifications.jsonl"),
    ]) {
      try { if (existsSync(stale)) unlinkSync(stale); } catch { /* ignore */ }
    }
  } catch { /* best-effort, notifications must never break loader activation */ }
}
