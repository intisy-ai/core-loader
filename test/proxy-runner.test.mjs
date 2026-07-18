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
});
