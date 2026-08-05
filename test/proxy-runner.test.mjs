import { describe, it } from "vitest";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startLoaderProxy } from "../dist/proxy-runner.js";

describe("proxy-runner", () => {
  it("startLoaderProxy wires the injected profile/port/configDir and derives the resolver from readDeployedProviders", async () => {
    // Isolated fake config dir with one deployed provider repo, so we can prove the
    // resolver startLoaderProxy builds is really derived from readDeployedProviders
    // (core-loader's own provider-discovery scan), not something app-proxy-specific.
    const configDir = mkdtempSync(join(tmpdir(), "core-loader-proxy-runner-"));
    const reposDir = join(configDir, "repos");
    const repoDir = join(reposDir, "fake-provider-repo");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({
        claudeHub: { authProviders: [{ name: "fake-provider", handler: "handler.js" }] },
      }),
    );

    const FAKE_PROFILE = { configFile: "fake.json", routingKey: "providerRouting" };

    let createProxyServerCall = null;
    let listProvidersFromResolver = null;

    const fakeServer = { listen: async () => 4242, close: async () => {} };

    function fakeCreateProxyServer(opts) {
      createProxyServerCall = opts;
      return fakeServer;
    }

    function fakeMakeDynamicResolver(listProviders) {
      listProvidersFromResolver = listProviders;
      return async (providerName) => {
        const match = listProviders().find((p) => p.provider === providerName);
        return match ? { handle: async () => new Response("ok") } : null;
      };
    }

    const logLines = [];
    function fakeLog(message) {
      logLines.push(message);
    }

    const started = await startLoaderProxy({
      createProxyServer: fakeCreateProxyServer,
      makeDynamicResolver: fakeMakeDynamicResolver,
      profile: FAKE_PROFILE,
      configDir,
      port: 9999,
      log: fakeLog,
    });

    // createProxyServer was called with exactly the injected profile + port + configDir,
    // plus a log fn and a resolveHandler fn built from readDeployedProviders.
    assert.ok(createProxyServerCall, "createProxyServer should have been called");
    assert.equal(createProxyServerCall.configDir, configDir);
    assert.equal(createProxyServerCall.profile, FAKE_PROFILE);
    assert.equal(createProxyServerCall.port, 9999);
    assert.equal(typeof createProxyServerCall.log, "function");
    assert.equal(typeof createProxyServerCall.resolveHandler, "function");

    // makeDynamicResolver's listProviders callback reflects readDeployedProviders(reposDir).
    assert.equal(typeof listProvidersFromResolver, "function");
    const discovered = listProvidersFromResolver();
    assert.deepEqual(discovered, [
      { provider: "fake-provider", handlerPath: join(repoDir, "handler.js") },
    ]);

    // The returned handle exposes the server + resolved dirs, and listen()'s resolved
    // port made it into the log line.
    assert.equal(started.server, fakeServer);
    assert.equal(started.configDir, configDir);
    assert.equal(started.reposDir, reposDir);
    assert.ok(logLines.some((l) => l.includes("127.0.0.1:4242")), "should log the bound port");

    // Start-marker stamped under <configDir>/logs/.proxy-started.
    const markerPath = join(configDir, "logs", ".proxy-started");
    assert.ok(existsSync(markerPath), ".proxy-started marker should be written");
    assert.ok(readFileSync(markerPath, "utf-8").length > 0);
  });

  it("threads the injected emitActivity into createProxyServer and emits a started lifecycle event", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "core-loader-proxy-runner-activity-"));

    const fakeServer = { listen: async () => 5050, close: async () => {} };
    let createProxyServerCall = null;
    function fakeCreateProxyServer(opts) {
      createProxyServerCall = opts;
      return fakeServer;
    }
    function fakeMakeDynamicResolver() {
      return async () => null;
    }

    const activityCalls = [];
    function fakeEmitActivity(spec) {
      activityCalls.push(spec);
    }

    await startLoaderProxy({
      createProxyServer: fakeCreateProxyServer,
      makeDynamicResolver: fakeMakeDynamicResolver,
      profile: {},
      configDir,
      port: 5050,
      log: () => {},
      emitActivity: fakeEmitActivity,
    });

    // createProxyServer must receive the injected emitActivity (so core-proxy can emit
    // its own activity), proving passthrough rather than core-loader swallowing it.
    assert.equal(typeof createProxyServerCall.emitActivity, "function");

    const started = activityCalls.find((c) => c.action === "started");
    assert.ok(started, "should emit a proxy.status started activity event");
    assert.equal(started.topic, "proxy.status");
    assert.equal(started.impact, "notice");
    assert.deepEqual(started.cause, { kind: "startup" });
  });

  it("wraps close() to emit a stopped lifecycle event while preserving close's own return value", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "core-loader-proxy-runner-stop-"));

    // Sentinel object identity is asserted below, proving the wrap forwards
    // close()'s real resolution rather than swallowing/replacing it.
    const CLOSE_SENTINEL = { reason: "closed-by-test" };
    const fakeServer = { listen: async () => 6060, close: async () => CLOSE_SENTINEL };
    function fakeCreateProxyServer() {
      return fakeServer;
    }
    function fakeMakeDynamicResolver() {
      return async () => null;
    }

    const activityCalls = [];
    function fakeEmitActivity(spec) {
      activityCalls.push(spec);
    }

    const started = await startLoaderProxy({
      createProxyServer: fakeCreateProxyServer,
      makeDynamicResolver: fakeMakeDynamicResolver,
      profile: {},
      configDir,
      port: 6060,
      log: () => {},
      emitActivity: fakeEmitActivity,
    });

    assert.equal(
      activityCalls.some((c) => c.action === "stopped"),
      false,
      "stopped must not fire before close() is called",
    );

    const closeResult = await started.server.close();

    assert.equal(closeResult, CLOSE_SENTINEL, "wrapped close() must resolve the original return value unchanged");

    const stopped = activityCalls.find((c) => c.action === "stopped");
    assert.ok(stopped, "should emit a proxy.status stopped activity event once close() runs");
    assert.equal(stopped.topic, "proxy.status");
    assert.equal(stopped.impact, "notice");
    assert.deepEqual(stopped.cause, { kind: "shutdown" });
  });

  it("returns the original server unwrapped when no emitActivity is injected", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "core-loader-proxy-runner-no-activity-"));

    const fakeServer = { listen: async () => 7070, close: async () => ({ ok: true }) };
    function fakeCreateProxyServer() {
      return fakeServer;
    }
    function fakeMakeDynamicResolver() {
      return async () => null;
    }

    const started = await startLoaderProxy({
      createProxyServer: fakeCreateProxyServer,
      makeDynamicResolver: fakeMakeDynamicResolver,
      profile: {},
      configDir,
      port: 7070,
      log: () => {},
    });

    assert.equal(started.server, fakeServer, "server should be returned unwrapped with no emitActivity injected");
  });
});
