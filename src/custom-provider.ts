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
import type { MenuAction, MenuInput } from "./provider-menu.js";

/** The plugin that serves custom endpoints, as core's capability registry named it. */
export interface CustomProviderEngine {
  /** Its plugin id, which is also its clone directory. */
  id: string;
  /** Where it is cloned from, when this home's plugin list or a marketplace named one. */
  url?: string;
}

/** Whether a custom provider can be added right now, and what stands in the way when it cannot. */
export type CustomProviderState =
  | {
      /** The plugin is deployed, so an endpoint can be added right now. */
      kind: "add";
      /** The plugin that will serve it. */
      engine: CustomProviderEngine;
    }
  | {
      /** The plugin is absent, but the manager here could fetch it. */
      kind: "install";
      /** The plugin to fetch. */
      engine: CustomProviderEngine;
    }
  | {
      /** Nothing here could serve a custom endpoint, so no row is offered. */
      kind: "unavailable";
      /** Why not. */
      reason: string;
    };

/** What `customProviderState` may have answered for it, so a test needs no real home. */
export interface CustomProviderDeps {
  /** Whether a path is present. */
  exists?: (path: string) => boolean;
  /** Whether this home has a plugin manager that could fetch the plugin. */
  hasManager?: () => boolean;
}

/** The endpoint being collected, one prompt at a time. */
export interface CustomEndpointDraft {
  /** The short id it is stored and routed under. */
  id?: string;
  /** What it is shown as, which starts out as the id. */
  label?: string;
  /** Which wire format it speaks. */
  format?: string;
  /** Where it serves its API. */
  baseUrl?: string;
  /** The model ids it advertises. */
  models?: string[];
}

/** What the caller answers on the plugin's behalf, because the plugin owns these rules. */
export interface CustomProviderActionDeps {
  /** The wire format to start from. */
  defaultFormat?: string;
  /** The plugin's own verdict on a draft, or an empty answer when it is fine. */
  validate: (endpoint: CustomEndpointDraft) => string | Promise<string | undefined> | undefined;
  /** Hands the finished endpoint and its key to the plugin, which stores them. */
  addEndpoint: (endpoint: CustomEndpointDraft, key: string) => unknown;
}

/**
 * Which of the three states the custom-provider row is in for this home.
 *
 * @param engine the plugin that provides custom endpoints, or nothing when none does.
 * @param reposDir where this home keeps its clones.
 * @param deps answers a test supplies instead of the filesystem.
 * @returns the state, carrying the engine when there is one to act on.
 */
export function customProviderState(engine: CustomProviderEngine | null | undefined, reposDir: string, deps: CustomProviderDeps = {}): CustomProviderState {
  if (!engine) return { kind: "unavailable", reason: "no plugin provides custom endpoints" };
  const exists = deps.exists || existsSync;
  if (exists(join(reposDir, engine.id))) return { kind: "add", engine };
  const hasManager = deps.hasManager ? deps.hasManager() : false;
  if (hasManager) return { kind: "install", engine };
  return { kind: "unavailable", reason: "install the plugin manager first" };
}

/** What the row says, or an empty string when there is no row to show. */
export function customProviderLabel(state: CustomProviderState | null | undefined): string {
  if (!state || state.kind === "unavailable") return "";
  return state.kind === "add" ? "Add a custom provider" : "Install custom providers";
}

/**
 * The chained prompts the TUI shows, as menu input-actions. Each step returns the next, so the
 * whole thing is one action from the caller's point of view.
 */
export function addCustomProviderAction(engine: CustomProviderEngine, deps: CustomProviderActionDeps): MenuAction {
  const draft: CustomEndpointDraft = { format: deps.defaultFormat || "openai" };
  const fail = (message: string): MenuAction => ({ refresh: true, flash: message });

  const askKey = (): MenuAction => ({
    input: {
      title: "API key",
      message: `Key for ${draft.id} (leave empty to add it later)`,
      secret: true,
      complete: (key: string) => Promise.resolve(deps.addEndpoint(draft, String(key || "").trim())).then(
        () => ({ refresh: true, flash: `Added ${draft.id}${String(key || "").trim() ? "" : " (no key yet)"}` }),
        (e) => fail(String((e && e.message) || e)),
      ),
    },
  });

  // A custom endpoint serves the models it advertises, so one with none is a provider that can
  // never answer. The plugin rejects that; asking here is what makes it answerable.
  const askModels = (): MenuAction => ({
    input: {
      title: "Models",
      message: `Model ids ${draft.id} serves, comma separated`,
      complete: (models: string) => {
        draft.models = String(models || "").split(",").map((m) => m.trim()).filter(Boolean);
        return Promise.resolve(deps.validate(draft)).then((problem) => (problem ? fail(problem) : askKey()));
      },
    },
  });

  const askBaseUrl = (): MenuAction => ({
    input: {
      title: "Base URL",
      message: `Where ${draft.id} serves its API, e.g. https://api.example.com/v1`,
      complete: (url: string) => {
        draft.baseUrl = String(url || "").trim();
        return askModels();
      },
    },
  });

  return {
    input: {
      title: "Custom provider",
      message: "A short id, e.g. my-endpoint",
      complete: (id: string) => {
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
