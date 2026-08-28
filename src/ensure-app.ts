import { existsSync } from "fs";
import { join, delimiter } from "path";
import { execFileSync } from "child_process";

/** Whether a binary resolves on this machine's PATH. */
export function binaryOnPath(binary: string): boolean {
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  return pathEnv.split(delimiter).some((dir) => exts.some((ext) => existsSync(join(dir, binary + ext))));
}

/**
 * Install the host app's CLI when it is absent, so connecting this loader from a
 * dashboard (or installing it in a fresh terminal) also provisions the app it
 * drives. A no-op whenever the binary is already on PATH, so normal launches
 * (where the app is obviously present) never pay for it. Best-effort: a failed
 * install is logged, never thrown.
 */
export function ensureAppCli(detect: { binary: string; pkg: string } | undefined, log: (message: string) => void): void {
  if (!detect || !detect.binary || !detect.pkg) return;
  if (binaryOnPath(detect.binary)) return;
  log(`App CLI '${detect.binary}' not found; installing ${detect.pkg}`);
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    execFileSync(npm, ["install", "-g", detect.pkg], { stdio: "ignore" });
    log(`Installed ${detect.pkg}`);
  } catch (e) {
    log(`Failed to install ${detect.pkg}: ${(e as { message?: string }).message ?? e}`);
  }
}
