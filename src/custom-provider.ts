// @ts-nocheck
// The "add a custom provider" row every loader's Providers view offers, and the install that
// has to happen first when the plugin backing it is absent.
//
// Nothing here names a plugin: the plugin is found by CAPABILITY in core's engine registry, so
// a loader gains this row without knowing which plugin implements it, and a different
// implementation would need no change here. Which of the three states the row is in depends on
// what is actually installed:
//
//   "add"         the plugin is deployed, so an endpoint can be added right now
//   "install"     it is absent but the plugin manager is present to fetch it
//   "unavailable" it is absent and nothing here could install it, so no row is offered
//
// Custom providers are per-endpoint: each configured endpoint becomes its own provider through
// the plugin's dynamic manifest, which is why the plugin itself is not a provider.

import { existsSync } from "fs";
import { join } from "path";

const CAPABILITY = "custom-endpoints";

// Read from core lazily: a loader bundles core, but this module is also unit-tested on its own
// where injecting the registry is what keeps it from needing the whole bundle.
export function customEndpointsEngine(deps = {}) {
  if (deps.engineByCapability) return deps.engineByCapability(CAPABILITY);
  return undefined;
}

export function customProviderState(engine, reposDir, deps = {}) {
  if (!engine) return { kind: "unavailable", reason: "no plugin provides custom endpoints" };
  const exists = deps.exists || existsSync;
  if (exists(join(reposDir, engine.id))) return { kind: "add", engine };
  const hasManager = deps.hasManager ? deps.hasManager() : false;
  if (hasManager) return { kind: "install", engine };
  return { kind: "unavailable", reason: "install the plugin manager first" };
}

export function customProviderLabel(state) {
  if (!state || state.kind === "unavailable") return "";
  return state.kind === "add" ? "Add a custom provider" : "Install custom providers";
}

// The endpoint list lives in the plugin's own config, under the key the engine descriptor
// names, and is written through core's config system like every other plugin setting.
export function readCustomEndpoints(engine, deps) {
  const name = engine && engine.meta && engine.meta.configName;
  if (!name) return [];
  const value = deps.getConfigValue(name, "endpoints");
  return Array.isArray(value) ? value : [];
}

export function endpointIdTaken(engine, id, deps) {
  return readCustomEndpoints(engine, deps).some((e) => e && e.id === id);
}

// A base URL has to be absolute: a relative one silently resolves against whatever the proxy
// is serving and every request to it fails far from here.
export function validateEndpoint(engine, endpoint, deps) {
  const id = (endpoint.id || "").trim();
  if (!id) return "an id is required";
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return "an id may only hold letters, digits, dot, dash and underscore";
  if (endpointIdTaken(engine, id, deps)) return `there is already an endpoint called ${id}`;
  const url = (endpoint.baseUrl || "").trim();
  if (!/^https?:\/\/.+/i.test(url)) return "the base URL must start with http:// or https://";
  return "";
}

// Writes the endpoint into the plugin's config, then hands the credential and the "make this
// routable" step to the plugin itself: a loader has no business holding either. Async because
// reaching the plugin means loading its bundle.
export async function saveCustomEndpoint(engine, endpoint, deps) {
  const problem = validateEndpoint(engine, endpoint, deps);
  if (problem) throw new Error(problem);
  const name = engine.meta.configName;
  const endpoints = readCustomEndpoints(engine, deps);
  const saved = {
    id: endpoint.id.trim(),
    label: (endpoint.label || endpoint.id).trim(),
    baseUrl: endpoint.baseUrl.trim(),
    format: endpoint.format || "openai",
    models: endpoint.models || [],
  };
  deps.setConfigValue(name, "endpoints", [...endpoints, saved]);
  // Without a key the provider exists but every request through it is unauthenticated, and
  // without the manifest step it is not routable at all until something else rewrites it.
  if (deps.applyEndpoint) await deps.applyEndpoint(saved, endpoint.key || "");
  return saved;
}

// The chained prompts the TUI shows, as menu input-actions. Each step returns the next, so the
// whole thing is one action from the caller's point of view.
export function addCustomProviderAction(engine, deps) {
  const draft = {};
  const fail = (message) => ({ refresh: true, flash: message });

  const askKey = () => ({
    input: {
      title: "API key",
      message: `Key for ${draft.id} (leave empty to add it later)`,
      secret: true,
      complete: (key) => {
        draft.key = (key || "").trim();
        return saveCustomEndpoint(engine, draft, deps).then(
          (saved) => ({ refresh: true, flash: `Added ${saved.id}${draft.key ? "" : " (no key yet)"}` }),
          (e) => fail(String((e && e.message) || e)),
        );
      },
    },
  });

  const askBaseUrl = () => ({
    input: {
      title: "Base URL",
      message: `Where ${draft.id} serves its API, e.g. https://api.example.com/v1`,
      complete: (url) => {
        draft.baseUrl = (url || "").trim();
        const problem = validateEndpoint(engine, draft, deps);
        // Only the URL is being answered here, so an id problem cannot be fixed by asking again.
        if (problem && /base URL/.test(problem)) return fail(problem);
        if (problem) return fail(problem);
        return askKey();
      },
    },
  });

  return {
    input: {
      title: "Custom provider",
      message: "A short id, e.g. my-endpoint",
      complete: (id) => {
        draft.id = (id || "").trim();
        draft.label = draft.id;
        if (!draft.id) return { refresh: true };
        const problem = validateEndpoint(engine, { ...draft, baseUrl: "http://placeholder" }, deps);
        if (problem) return fail(problem);
        return askBaseUrl();
      },
    },
  };
}
