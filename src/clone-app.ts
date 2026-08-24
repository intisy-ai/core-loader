import { join } from "path";
import { readJson } from "./json.js";

/**
 * The app a clone declares itself the loader for, or null when it declares none.
 *
 * @remarks
 * An app's loader carries an `app` descriptor in its `cairn.json`; an ordinary plugin's descriptor
 * has no such key. That makes "whose loader is this" answerable without naming any plugin, which is
 * what this library needs to hide another app's loader from a list it should never offer.
 */
export function appOfClone(reposDir: string, name: string): string | null {
  const descriptor = readJson(join(reposDir, name, "cairn.json"));
  const id = (descriptor as { app?: { id?: unknown } } | null)?.app?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
