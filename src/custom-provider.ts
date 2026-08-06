// @ts-nocheck
// The "add a custom provider" row every loader's Providers view offers, and the install that
// has to happen first when the plugin backing it is absent.
//
// Nothing here names a plugin: the plugin is found by CAPABILITY in core's registry, so a
// loader gains this row without knowing which plugin implements it. Which of the three states
// the row is in depends on what is actually installed:
//
//   "add"         the plugin is deployed, so an endpoint can be added right now
//   "install"     it is absent but the plugin manager is present to fetch it
//   "unavailable" it is absent and nothing here could install it, so no row is offered
//
// What an endpoint IS, whether one would work, and where it is stored are the plugin's own
// business. This file collects answers and hands them over whole: a second copy of those rules
// here is how the loader and the dashboard came to disagree about what a valid endpoint is.

import { existsSync } from "fs";
import { join } from "path";

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

// The chained prompts the TUI shows, as menu input-actions. Each step returns the next, so the
// whole thing is one action from the caller's point of view.
export function addCustomProviderAction(engine, deps) {
  const draft = { format: deps.defaultFormat || "openai" };
  const fail = (message) => ({ refresh: true, flash: message });

  const askKey = () => ({
    input: {
      title: "API key",
      message: `Key for ${draft.id} (leave empty to add it later)`,
      secret: true,
      complete: (key) => Promise.resolve(deps.addEndpoint(draft, String(key || "").trim())).then(
        () => ({ refresh: true, flash: `Added ${draft.id}${String(key || "").trim() ? "" : " (no key yet)"}` }),
        (e) => fail(String((e && e.message) || e)),
      ),
    },
  });

  // A custom endpoint serves the models it advertises, so one with none is a provider that can
  // never answer. The plugin rejects that; asking here is what makes it answerable.
  const askModels = () => ({
    input: {
      title: "Models",
      message: `Model ids ${draft.id} serves, comma separated`,
      complete: (models) => {
        draft.models = String(models || "").split(",").map((m) => m.trim()).filter(Boolean);
        return Promise.resolve(deps.validate(draft)).then((problem) => (problem ? fail(problem) : askKey()));
      },
    },
  });

  const askBaseUrl = () => ({
    input: {
      title: "Base URL",
      message: `Where ${draft.id} serves its API, e.g. https://api.example.com/v1`,
      complete: (url) => {
        draft.baseUrl = String(url || "").trim();
        return askModels();
      },
    },
  });

  return {
    input: {
      title: "Custom provider",
      message: "A short id, e.g. my-endpoint",
      complete: (id) => {
        draft.id = String(id || "").trim();
        draft.label = draft.id;
        if (!draft.id) return { refresh: true };
        // Only the id is known yet, so only an id problem can be reported at this point.
        return Promise.resolve(deps.validate({ ...draft, baseUrl: "https://placeholder.invalid", models: ["placeholder"] }))
          .then((problem) => (problem && /id/i.test(problem) ? fail(problem) : askBaseUrl()));
      },
    },
  };
}
