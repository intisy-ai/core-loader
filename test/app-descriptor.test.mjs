import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir;
const saved = {};
const KEYS = ["HUB_APPS_FILE", "HUB_CONFIG_DIR", "HUB_APP_ID"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "core-loader-descriptor-"));
  for (const key of KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  mkdirSync(join(dir, "repos", "zeta-loader"), { recursive: true });
  writeFileSync(join(dir, "apps.json"), JSON.stringify({
    zeta: {
      id: "zeta", label: "Zeta", home: { candidates: [dir] },
      detect: { binary: "zeta", pkg: "zeta-cli" },
      loader: { id: "zeta-loader", url: "intisy-ai/zeta-loader" },
      accent: "#123456",
    },
  }));
  process.env.HUB_APPS_FILE = join(dir, "apps.json");
  process.env.HUB_CONFIG_DIR = dir;
  process.env.HUB_APP_ID = "zeta";
  vi.resetModules();
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("the active descriptor", () => {
  it("comes from the registry", async () => {
    const { activeDescriptor } = await import("../dist/app-descriptor.js");
    expect(activeDescriptor().label).toBe("Zeta");
    expect(activeDescriptor().accent).toBe("#123456");
  });

  it("is overlaid by the installed loader clone, which is fresher than the registry", async () => {
    writeFileSync(join(dir, "repos", "zeta-loader", "plugin.json"), JSON.stringify({
      id: "zeta-loader-id",
      api: 1,
      displayName: "Zeta Loader",
      app: { id: "zeta", label: "Zeta", home: { candidates: [dir] }, accent: "#abcdef", discovery: { topic: "zeta-plugin" } },
    }));
    const { activeDescriptor } = await import("../dist/app-descriptor.js");
    expect(activeDescriptor().accent).toBe("#abcdef");
    expect(activeDescriptor().discovery.topic).toBe("zeta-plugin");
  });

  it("is null when the app is unknown, rather than another app's", async () => {
    process.env.HUB_APP_ID = "nobody";
    const { activeDescriptor } = await import("../dist/app-descriptor.js");
    expect(activeDescriptor()).toBe(null);
  });
});

describe("the loader whose config this home holds", () => {
  it("is the clone that declares an app", async () => {
    writeFileSync(join(dir, "repos", "zeta-loader", "plugin.json"), JSON.stringify({
      id: "zeta-loader-id",
      api: 1,
      app: { id: "zeta", label: "Zeta", home: { candidates: [dir] }, loader: { id: "zeta-loader", url: "u" } },
    }));
    const { loaderIdOfHome } = await import("../dist/app-descriptor.js");
    expect(loaderIdOfHome()).toBe("zeta-loader");
  });

  it("falls back to the registry's declared loader when no clone is installed", async () => {
    const { loaderIdOfHome } = await import("../dist/app-descriptor.js");
    expect(loaderIdOfHome()).toBe("zeta-loader");
  });

  it("is empty when nothing declares one", async () => {
    writeFileSync(join(dir, "apps.json"), JSON.stringify({ zeta: { id: "zeta", label: "Zeta", home: { candidates: [dir] } } }));
    const { loaderIdOfHome } = await import("../dist/app-descriptor.js");
    expect(loaderIdOfHome()).toBe("");
  });
});

describe("trait accessors return the safe default when nothing is declared", () => {
  it("answers no npm plugin mechanism, no discovery, no projects", async () => {
    writeFileSync(join(dir, "apps.json"), JSON.stringify({ zeta: { id: "zeta", label: "Zeta", home: { candidates: [dir] } } }));
    const mod = await import("../dist/app-descriptor.js");
    expect(mod.appNpmPlugins()).toBe(null);
    expect(mod.appDiscovery()).toEqual({});
    expect(mod.appProjects()).toEqual({});
    expect(mod.appAccent()).toBe("");
  });
});
