import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readDeployedManifests } from "./plugin-manifests.js";

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "loader-manifests-"));
  mkdirSync(join(dir, "plugin"), { recursive: true });
  return join(dir, "plugin");
}

function write(pluginDir: string, id: string, manifest: unknown, withEntry = true): void {
  writeFileSync(join(pluginDir, `${id}.json`), JSON.stringify(manifest), "utf-8");
  if (withEntry) writeFileSync(join(pluginDir, `${id}.js`), "export default {};", "utf-8");
}

describe("readDeployedManifests", () => {
  it("returns nothing for a home with no plugin directory", () => {
    const scan = readDeployedManifests(join(tmpdir(), "loader-manifests-absent", "plugin"));
    expect(scan).toEqual({ loaded: [], failed: [] });
  });

  it("loads a valid manifest and resolves its entry beside it", () => {
    const dir = home();
    write(dir, "demo", { id: "demo", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    const scan = readDeployedManifests(dir);
    expect(scan.failed).toEqual([]);
    expect(scan.loaded).toHaveLength(1);
    expect(scan.loaded[0].manifest.id).toBe("demo");
    expect(scan.loaded[0].entryPath).toBe(join(dir, "demo.js"));
  });

  it("resolves no entry for a manifest whose bundle is missing", () => {
    const dir = home();
    write(dir, "no-bundle", { id: "no-bundle", api: 1, entry: "dist/index.js", capabilities: ["settings"] }, false);
    expect(readDeployedManifests(dir).loaded[0].entryPath).toBeNull();
  });

  it("resolves no entry for a library manifest that declares none", () => {
    const dir = home();
    writeFileSync(join(dir, "lib.json"), JSON.stringify({ id: "lib", api: 1 }), "utf-8");
    const scan = readDeployedManifests(dir);
    expect(scan.loaded[0].entryPath).toBeNull();
    expect(scan.failed).toEqual([]);
  });

  it("reports an invalid manifest without discarding the valid ones", () => {
    const dir = home();
    write(dir, "good", { id: "good", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ api: 1 }), "utf-8");
    const scan = readDeployedManifests(dir);
    expect(scan.loaded.map((plugin) => plugin.manifest.id)).toEqual(["good"]);
    expect(scan.failed).toHaveLength(1);
    expect(scan.failed[0].detail).toContain("id");
  });

  it("reports unparseable JSON as a failure naming the file", () => {
    const dir = home();
    writeFileSync(join(dir, "broken.json"), "{not json", "utf-8");
    const scan = readDeployedManifests(dir);
    expect(scan.loaded).toEqual([]);
    expect(scan.failed).toHaveLength(1);
    expect(scan.failed[0].pluginId).toBe("broken");
    expect(scan.failed[0].fix).toContain("plugin.json");
  });

  it("ignores a file that is not a manifest", () => {
    const dir = home();
    write(dir, "demo", { id: "demo", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    writeFileSync(join(dir, "notes.txt"), "hello", "utf-8");
    expect(readDeployedManifests(dir).loaded).toHaveLength(1);
  });

  it("orders the result by id so a host activates deterministically", () => {
    const dir = home();
    write(dir, "zebra", { id: "zebra", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    write(dir, "alpha", { id: "alpha", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    expect(readDeployedManifests(dir).loaded.map((plugin) => plugin.manifest.id)).toEqual(["alpha", "zebra"]);
  });
});
