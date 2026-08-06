import { describe, it } from "vitest";
import assert from "node:assert";
import {
  customProviderState,
  customProviderLabel,
  readCustomEndpoints,
  validateEndpoint,
  saveCustomEndpoint,
  addCustomProviderAction,
} from "../dist/custom-provider.js";

const ENGINE = { id: "custom-auth", url: "u", capability: "custom-endpoints", target: "cairn", meta: { providerId: "custom", configName: "custom-auth" } };

let config;
let keys;

function deps(overrides) {
  return {
    getConfigValue: (name, key) => (config[name] || {})[key],
    setConfigValue: (name, key, value) => { config[name] = config[name] || {}; config[name][key] = value; },
    saveKey: (id, key) => { keys.push({ id, key }); },
    ...(overrides || {}),
  };
}

function reset() { config = {}; keys = []; }

describe("customProviderState", () => {
  it("offers to add once the plugin is deployed", () => {
    reset();
    const state = customProviderState(ENGINE, "/repos", { exists: (p) => p.endsWith("custom-auth") });
    assert.equal(state.kind, "add");
    assert.equal(customProviderLabel(state), "Add a custom provider");
  });

  // Installing it is the plugin manager's job, so without the manager there is nothing to offer.
  it("offers to install it when the manager is there to do it", () => {
    reset();
    const state = customProviderState(ENGINE, "/repos", { exists: () => false, hasManager: () => true });
    assert.equal(state.kind, "install");
    assert.equal(customProviderLabel(state), "Install custom providers");
  });

  it("offers nothing when it is absent and nothing could install it", () => {
    reset();
    const state = customProviderState(ENGINE, "/repos", { exists: () => false, hasManager: () => false });
    assert.equal(state.kind, "unavailable");
    assert.equal(customProviderLabel(state), "");
  });

  it("offers nothing when no plugin claims the capability at all", () => {
    reset();
    assert.equal(customProviderState(undefined, "/repos", {}).kind, "unavailable");
  });
});

describe("validateEndpoint", () => {
  it("requires an id, and one that can be used", () => {
    reset();
    assert.match(validateEndpoint(ENGINE, { id: "", baseUrl: "https://a.b" }, deps()), /id is required/);
    assert.match(validateEndpoint(ENGINE, { id: "has spaces", baseUrl: "https://a.b" }, deps()), /letters, digits/);
  });

  // A relative base URL resolves against whatever the proxy serves, so every request fails
  // far from where the mistake was made.
  it("requires an absolute base URL", () => {
    reset();
    assert.match(validateEndpoint(ENGINE, { id: "e1", baseUrl: "/v1" }, deps()), /http/);
    assert.equal(validateEndpoint(ENGINE, { id: "e1", baseUrl: "https://api.example.com/v1" }, deps()), "");
  });

  it("refuses an id that is already configured", () => {
    reset();
    config["custom-auth"] = { endpoints: [{ id: "taken", baseUrl: "https://a.b", format: "openai", models: [] }] };
    assert.match(validateEndpoint(ENGINE, { id: "taken", baseUrl: "https://a.b" }, deps()), /already an endpoint/);
  });
});

describe("saveCustomEndpoint", () => {
  it("appends the endpoint and stores its key under its own id", () => {
    reset();
    saveCustomEndpoint(ENGINE, { id: "mine", baseUrl: "https://api.example.com/v1", key: "sk-secret" }, deps());
    assert.deepEqual(readCustomEndpoints(ENGINE, deps()), [
      { id: "mine", label: "mine", baseUrl: "https://api.example.com/v1", format: "openai", models: [] },
    ]);
    assert.deepEqual(keys, [{ id: "mine", key: "sk-secret" }]);
  });

  it("keeps the endpoints already configured", () => {
    reset();
    config["custom-auth"] = { endpoints: [{ id: "first", baseUrl: "https://a.b", format: "openai", models: [] }] };
    saveCustomEndpoint(ENGINE, { id: "second", baseUrl: "https://c.d" }, deps());
    assert.deepEqual(readCustomEndpoints(ENGINE, deps()).map((e) => e.id), ["first", "second"]);
  });

  it("saves no key when none was given, so the endpoint waits for one", () => {
    reset();
    saveCustomEndpoint(ENGINE, { id: "mine", baseUrl: "https://a.b", key: "" }, deps());
    assert.deepEqual(keys, []);
  });

  it("refuses to write an endpoint that would not work", () => {
    reset();
    assert.throws(() => saveCustomEndpoint(ENGINE, { id: "mine", baseUrl: "nope" }, deps()), /base URL/);
    assert.equal(config["custom-auth"], undefined);
  });
});

describe("addCustomProviderAction", () => {
  it("asks for an id, a base URL and a key, then saves", () => {
    reset();
    let saved = 0;
    const first = addCustomProviderAction(ENGINE, deps({ afterSave: () => { saved++; } }));
    assert.equal(first.input.title, "Custom provider");

    const second = first.input.complete("mine");
    assert.equal(second.input.title, "Base URL");

    const third = second.input.complete("https://api.example.com/v1");
    assert.equal(third.input.title, "API key");
    // A key is a credential, so the prompt must not echo it.
    assert.equal(third.input.secret, true);

    const done = third.input.complete("sk-secret");
    assert.match(done.flash, /Added mine/);
    assert.equal(readCustomEndpoints(ENGINE, deps()).length, 1);
    assert.deepEqual(keys, [{ id: "mine", key: "sk-secret" }]);
    assert.equal(saved, 1);
  });

  it("says so and saves nothing when the id is already taken", () => {
    reset();
    config["custom-auth"] = { endpoints: [{ id: "mine", baseUrl: "https://a.b", format: "openai", models: [] }] };
    const result = addCustomProviderAction(ENGINE, deps()).input.complete("mine");
    assert.match(result.flash, /already an endpoint/);
    assert.equal(result.input, undefined);
    assert.equal(readCustomEndpoints(ENGINE, deps()).length, 1);
  });

  it("stops without complaint when the id is left empty", () => {
    reset();
    assert.deepEqual(addCustomProviderAction(ENGINE, deps()).input.complete(""), { refresh: true });
  });

  it("rejects a base URL that is not absolute and never reaches the key prompt", () => {
    reset();
    const step = addCustomProviderAction(ENGINE, deps()).input.complete("mine");
    const result = step.input.complete("api.example.com");
    assert.match(result.flash, /http/);
    assert.equal(result.input, undefined);
  });

  it("saves the endpoint with no key when the key prompt is left empty", () => {
    reset();
    const step = addCustomProviderAction(ENGINE, deps()).input.complete("mine");
    const done = step.input.complete("https://a.b").input.complete("");
    assert.match(done.flash, /no key yet/);
    assert.equal(readCustomEndpoints(ENGINE, deps()).length, 1);
    assert.deepEqual(keys, []);
  });
});
