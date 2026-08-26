import { join } from "path";
import { readCloneManifest } from "@intisy-ai/core";

/**
 * The app a clone declares itself the loader for, or null when it declares none.
 *
 * @remarks
 * An app's loader carries an `app` descriptor in its manifest; an ordinary plugin's manifest has no
 * such block. That makes "whose loader is this" answerable without naming any plugin, which is what
 * this library needs to hide another app's loader from a list it should never offer.
 */
export function appOfClone(reposDir: string, name: string): string | null {
  const id = readCloneManifest(join(reposDir, name))?.app?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
