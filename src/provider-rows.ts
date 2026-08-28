// The Providers view's own rows, shared by every loader. A loader lists the providers it
// discovered and then appends whatever this returns, so a new row (today: adding a custom
// provider, or installing the plugin that backs them) reaches every loader at once instead of
// being written into each one.
//
// Nothing here names a plugin or an app. The plugin behind custom providers is found by
// capability, installing it is delegated to the plugin manager the loader already has, and the
// endpoint itself is validated and stored by that plugin. Every input arrives through ctx, so this
// stays a pure function of what the calling view already holds.

import { customProviderState, customProviderLabel, addCustomProviderAction } from "./custom-provider.js";
import type { CustomEndpointDraft, CustomProviderEngine } from "./custom-provider.js";
import type { MenuAction } from "./provider-menu.js";
import type { AccountMenuApi } from "./account-menu.js";
import { CUSTOM_ENDPOINTS } from "@intisy-ai/core";

/** What the calling view already holds, handed over whole so this stays a pure function of it. */
export interface ExtraProviderRowsContext {
  /** Finds the plugin providing a capability, so no row here names one. */
  pluginByCapability: (capabilityId: string) => CustomProviderEngine | null | undefined;
  /** Where this home keeps its clones. */
  reposDir: string;
  /** Whether a path is present. */
  exists?: (path: string) => boolean;
  /** Whether this home has a plugin manager. */
  hasManager?: () => boolean;
  /** The wire format a new endpoint starts on. */
  defaultFormat?: string;
  /** Installs the plugin behind these rows, through the manager the loader already has. */
  install: (engine: CustomProviderEngine, tuiApi: AccountMenuApi) => void;
  /** Opens a chained prompt in the loader's own menu. */
  openAction: (action: MenuAction, tuiApi: AccountMenuApi, label: string) => void;
  /** Asks the plugin whether an endpoint would work. */
  validate: (engine: CustomProviderEngine, endpoint: CustomEndpointDraft) => string | Promise<string | undefined> | undefined;
  /** Asks the plugin to store an endpoint and its key. */
  addEndpoint: (engine: CustomProviderEngine, endpoint: CustomEndpointDraft, key: string) => unknown;
}

/** One row the Providers view appends after the providers it discovered. */
export interface ExtraProviderRow {
  /** Its id, which is what the view keys the row by. */
  id: string;
  /** What it says. */
  label: string;
  /** The line under it. */
  hint: string;
  /** What Enter does. */
  run: (tuiApi: AccountMenuApi) => void;
}

/**
 * Rows the view appends after the discovered providers. Each carries a `run(tuiApi)` the view
 * calls on Enter; an empty list means there is nothing actionable to show.
 */
export function extraProviderRows(ctx: ExtraProviderRowsContext): ExtraProviderRow[] {
  const engine = ctx.pluginByCapability(CUSTOM_ENDPOINTS.id);
  const state = customProviderState(engine, ctx.reposDir, { exists: ctx.exists, hasManager: ctx.hasManager });
  if (state.kind === "unavailable") return [];
  const label = customProviderLabel(state);

  if (state.kind === "install") {
    return [{
      id: "install-custom-providers",
      label,
      hint: "adds the plugin that serves your own endpoints",
      run: (tuiApi: AccountMenuApi) => ctx.install(state.engine, tuiApi),
    }];
  }

  return [{
    id: "add-custom-provider",
    label,
    hint: "an endpoint of your own, served as its own provider",
    // The plugin decides what a valid endpoint is, stores it, and makes it routable. The
    // loader only says which plugin to ask and passes the answers along.
    run: (tuiApi: AccountMenuApi) => ctx.openAction(addCustomProviderAction(state.engine, {
      defaultFormat: ctx.defaultFormat,
      validate: (endpoint: CustomEndpointDraft) => ctx.validate(state.engine, endpoint),
      addEndpoint: (endpoint: CustomEndpointDraft, key: string) => ctx.addEndpoint(state.engine, endpoint, key),
    }), tuiApi, label),
  }];
}
