import type { PluginLedgerRow } from "@intisy-ai/api/host";

function listed(label: string, values: string[]): string[] {
  return values.length ? [label + ": " + values.join(", ")] : [];
}

/**
 * One plugin's relationship record as lines a terminal can print.
 *
 * @remarks
 * The reason and the fix lead, because the only time a reader opens this screen is when something
 * did not appear and they want to know why. Everything else is the ledger in declaration order:
 * what it declared, what it provided, what it offered other plugins, and what it asked of them.
 */
export function diagnosticLines(row: PluginLedgerRow | null): string[] {
  if (!row) return ["This plugin did not load through the plugin host."];
  const lines = ["Status: " + row.status];
  if (row.error) {
    lines.push("Reason: " + row.error.detail);
    lines.push("Fix: " + row.error.fix);
  }
  const missing = row.capabilitiesDeclared.filter((id) => !row.capabilities.includes(id));
  lines.push(...listed("Capabilities", row.capabilities));
  lines.push(...listed("Declared but not provided", missing));
  lines.push(...listed("Provides", row.services.provides));
  lines.push(...listed("Consumes", row.services.consumes));
  lines.push(...listed("Unresolved", row.unresolved));
  lines.push(...listed("Subscribes", row.topics));
  lines.push(...listed("Permissions", row.permissions));
  return lines;
}
