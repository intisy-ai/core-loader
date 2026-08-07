import { describe, it } from "vitest";
import assert from "node:assert";
import { customProviderState, customProviderLabel, addCustomProviderAction } from "../dist/custom-provider.js";

const ENGINE = { id: "custom-auth", url: "u", capability: "custom-endpoints", target: "cairn", meta: { configName: "custom-auth" } };

// Stands in for the deployed plugin: it owns the rules, so the tests state them once here the
// way the real plugin does, and assert this library asks rather than deciding.
let added;
function deps(overrides) {
  return {
    validate: async (endpoint) => {
      if (!/^[A-Za-z0-9._-]+$/.test(endpoint.id || "")) return "endpoint id may only use letters, numbers, dot, dash and underscore";
      if (!(endpoint.models || []).length) return "at least one model id is required";
      return null;
    },
    addEndpoint: async (endpoint, key) => { added.push({ endpoint, key }); },
    ...(overrides || {}),
  };
}
function reset() { added = []; }

describe("customProviderState", () => {
  it("offers to add once the plugin is deployed", () => {
    const state = customProviderState(ENGINE, "/repos", { exists: (p) => p.endsWith("custom-auth") });
    assert.equal(state.kind, "add");
    assert.equal(customProviderLabel(state), "Add a custom provider");
  });

  // Installing it is the plugin manager's job, so without the manager there is nothing to offer.
  it("offers to install it when the manager is there to do it", () => {
    const state = customProviderState(ENGINE, "/repos", { exists: () => false, hasManager: () => true });
    assert.equal(state.kind, "install");
    assert.equal(customProviderLabel(state), "Install custom providers");
  });

  it("offers nothing when it is absent and nothing could install it", () => {
    const state = customProviderState(ENGINE, "/repos", { exists: () => false, hasManager: () => false });
    assert.equal(state.kind, "unavailable");
    assert.equal(customProviderLabel(state), "");
  });

  it("offers nothing when no plugin claims the capability at all", () => {
    assert.equal(customProviderState(undefined, "/repos", {}).kind, "unavailable");
  });
});

describe("addCustomProviderAction", () => {
  it("asks for an id, a base URL, models and a key, then hands the endpoint over whole", async () => {
    reset();
    const first = addCustomProviderAction(ENGINE, deps());
    assert.equal(first.input.title, "Custom provider");

    const second = await first.input.complete("mine");
    assert.equal(second.input.title, "Base URL");

    const third = second.input.complete("https://api.example.com/v1");
    assert.equal(third.input.title, "Models");

    const fourth = await third.input.complete("gpt-4o, gpt-4o-mini");
    assert.equal(fourth.input.title, "API key");
    // A key is a credential, so the prompt must not echo it.
    assert.equal(fourth.input.secret, true);

    const done = await fourth.input.complete("sk-secret");
    assert.match(done.flash, /Added mine/);
    assert.equal(added.length, 1);
    assert.deepEqual(added[0].endpoint, {
      format: "openai", id: "mine", label: "mine",
      baseUrl: "https://api.example.com/v1", models: ["gpt-4o", "gpt-4o-mini"],
    });
    assert.equal(added[0].key, "sk-secret");
  });

  // The rules live in the plugin; this library must report what it says, not judge for itself.
  it("reports the plugin's verdict on an id and stops there", async () => {
    reset();
    const result = await addCustomProviderAction(ENGINE, deps()).input.complete("has spaces");
    assert.match(result.flash, /letters, numbers/);
    assert.equal(result.input, undefined);
    assert.equal(added.length, 0);
  });

  // An endpoint with no models is a provider that can never answer, which is why it is asked
  // for and why the plugin's refusal has to surface here.
  it("reports the plugin's refusal of an endpoint with no models", async () => {
    reset();
    const step = await addCustomProviderAction(ENGINE, deps()).input.complete("mine");
    const models = await step.input.complete("https://a.b").input.complete("");
    assert.match(models.flash, /at least one model/);
    assert.equal(models.input, undefined);
    assert.equal(added.length, 0);
  });

  it("stops without complaint when the id is left empty", async () => {
    reset();
    assert.deepEqual(await addCustomProviderAction(ENGINE, deps()).input.complete(""), { refresh: true });
  });

  it("adds the endpoint with no key when the key prompt is left empty", async () => {
    reset();
    const step = await addCustomProviderAction(ENGINE, deps()).input.complete("mine");
    const models = await step.input.complete("https://a.b").input.complete("m1");
    const done = await models.input.complete("");
    assert.match(done.flash, /no key yet/);
    assert.equal(added.length, 1);
    assert.equal(added[0].key, "");
  });

  it("surfaces a failure from the plugin instead of claiming the endpoint was added", async () => {
    reset();
    const failing = deps({ addEndpoint: async () => { throw new Error("config is read-only"); } });
    const step = await addCustomProviderAction(ENGINE, failing).input.complete("mine");
    const models = await step.input.complete("https://a.b").input.complete("m1");
    const done = await models.input.complete("sk-secret");
    assert.match(done.flash, /config is read-only/);
  });
});
