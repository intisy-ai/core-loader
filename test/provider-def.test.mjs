import { describe, it } from "vitest";
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProviderDefs, loadProviderDefsResult } from "../dist/provider-def.js";

function writeHandler(source) {
  const dir = mkdtempSync(join(tmpdir(), "core-loader-provider-def-"));
  const handlerPath = join(dir, "handler.mjs");
  writeFileSync(handlerPath, source);
  return handlerPath;
}

describe("loadProviderDefs: def export", () => {
  it("returns [def], defaulting accountPool to id", async () => {
    const handlerPath = writeHandler(
      `export const def = { id: "stub", label: "Stub", models: { a: {} }, hasOAuth: false };`,
    );
    const defs = await loadProviderDefs(handlerPath);
    assert.deepEqual(defs, [{ id: "stub", label: "Stub", models: { a: {} }, hasOAuth: false, settings: undefined, translator: undefined, accountPool: "stub" }]);
  });

  it("keeps an explicit accountPool instead of defaulting to id", async () => {
    const handlerPath = writeHandler(
      `export const def = { id: "gemini-cli", label: "Gemini CLI", models: {}, hasOAuth: true, accountPool: "google" };`,
    );
    const [defOut] = await loadProviderDefs(handlerPath);
    assert.equal(defOut.accountPool, "google");
  });
});

describe("loadProviderDefs: defs export", () => {
  it("returns the full defs array for a multi-provider handler", async () => {
    const handlerPath = writeHandler(`
      export const defs = [
        { id: "antigravity", label: "Antigravity", models: {}, hasOAuth: true, accountPool: "google" },
        { id: "gemini-cli", label: "Gemini CLI", models: {}, hasOAuth: true, accountPool: "google" },
      ];
    `);
    const defs = await loadProviderDefs(handlerPath);
    assert.equal(defs.length, 2);
    assert.deepEqual(defs.map((d) => d.id), ["antigravity", "gemini-cli"]);
    assert.ok(defs.every((d) => d.accountPool === "google"));
  });
});

describe("loadProviderDefs: resolveProviders export", () => {
  it("calls resolveProviders and returns its result", async () => {
    const handlerPath = writeHandler(`
      export async function resolveProviders() {
        return [{ id: "my-endpoint", label: "My Endpoint", models: {}, hasOAuth: false }];
      }
    `);
    const defs = await loadProviderDefs(handlerPath);
    assert.deepEqual(defs.map((d) => d.id), ["my-endpoint"]);
  });

  it("returns [] when resolveProviders throws", async () => {
    const handlerPath = writeHandler(`
      export function resolveProviders() { throw new Error("config unreadable"); }
    `);
    assert.deepEqual(await loadProviderDefs(handlerPath), []);
  });

  it("returns [] when resolveProviders resolves to something other than an array", async () => {
    const handlerPath = writeHandler(`export async function resolveProviders() { return "nope"; }`);
    assert.deepEqual(await loadProviderDefs(handlerPath), []);
  });
});

describe("loadProviderDefs: no usable export", () => {
  it("returns [] for a handler exporting neither def, defs, nor resolveProviders", async () => {
    const handlerPath = writeHandler(`export const somethingElse = 1;`);
    assert.deepEqual(await loadProviderDefs(handlerPath), []);
  });

  it("returns [] when the module fails to import (missing file)", async () => {
    const defs = await loadProviderDefs(join(tmpdir(), "core-loader-provider-def-missing", "nope.mjs"));
    assert.deepEqual(defs, []);
  });

  it("drops entries lacking an id or label instead of throwing", async () => {
    const handlerPath = writeHandler(`
      export const defs = [
        { label: "No id", models: {}, hasOAuth: false },
        { id: "no-label", models: {}, hasOAuth: false },
        { id: "valid", label: "Valid", models: {}, hasOAuth: false },
      ];
    `);
    const defs = await loadProviderDefs(handlerPath);
    assert.deepEqual(defs.map((d) => d.id), ["valid"]);
  });
});

describe("loadProviderDefsResult", () => {
  it("resolves defs with no error for a handler exporting defs", async () => {
    const handlerPath = writeHandler(`
      export const defs = [{ id: "stub", label: "Stub", models: {}, hasOAuth: false }];
    `);
    const result = await loadProviderDefsResult(handlerPath);
    assert.deepEqual(result.defs.map((d) => d.id), ["stub"]);
    assert.equal(result.error, undefined);
  });

  it("resolves an error naming the failure when the module fails to import", async () => {
    const handlerPath = join(tmpdir(), "core-loader-provider-def-missing", "nope.mjs");
    const result = await loadProviderDefsResult(handlerPath);
    assert.deepEqual(result.defs, []);
    assert.equal(typeof result.error, "string");
    assert.ok(result.error.length > 0);
  });

  it("resolves an error when resolveProviders throws", async () => {
    const handlerPath = writeHandler(`
      export function resolveProviders() { throw new Error("config unreadable"); }
    `);
    const result = await loadProviderDefsResult(handlerPath);
    assert.deepEqual(result.defs, []);
    assert.match(result.error, /config unreadable/);
  });

  it("resolves defs: [] with no error for a handler exporting none of the three shapes", async () => {
    const handlerPath = writeHandler(`export const somethingElse = 1;`);
    const result = await loadProviderDefsResult(handlerPath);
    assert.deepEqual(result.defs, []);
    assert.equal(result.error, undefined);
  });

  it("resolves defs: [] with no error when resolveProviders resolves to something other than an array", async () => {
    const handlerPath = writeHandler(`export async function resolveProviders() { return "nope"; }`);
    const result = await loadProviderDefsResult(handlerPath);
    assert.deepEqual(result.defs, []);
    assert.equal(result.error, undefined);
  });
});

describe("loadProviderDefs delegates to loadProviderDefsResult", () => {
  it("still returns a bare array", async () => {
    const handlerPath = writeHandler(`
      export const defs = [{ id: "stub", label: "Stub", models: {}, hasOAuth: false }];
    `);
    const defs = await loadProviderDefs(handlerPath);
    assert.ok(Array.isArray(defs));
    assert.deepEqual(defs.map((d) => d.id), ["stub"]);
  });

  it("still returns [] when the module fails to import", async () => {
    const handlerPath = join(tmpdir(), "core-loader-provider-def-missing", "nope.mjs");
    assert.deepEqual(await loadProviderDefs(handlerPath), []);
  });

  it("still returns [] when resolveProviders throws", async () => {
    const handlerPath = writeHandler(`
      export function resolveProviders() { throw new Error("config unreadable"); }
    `);
    assert.deepEqual(await loadProviderDefs(handlerPath), []);
  });
});
