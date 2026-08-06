// @ts-nocheck
// The Providers view's own rows, shared by every loader. A loader lists the providers it
// discovered and then appends whatever this returns, so a new row (today: adding a custom
// provider, or installing the plugin that backs them) reaches every loader at once instead of
// being written into each one.
//
// Nothing here names a plugin or an app. The plugin behind custom providers is found by
// capability, and installing it is delegated to the plugin manager the loader already has.
// core's registry and config system arrive through ctx: this library sits inside a loader and
// does not carry core itself, so the loader passes in what it already has.

import { customProviderState, customProviderLabel, addCustomProviderAction } from "./custom-provider.js";

// Rows the view appends after the discovered providers. Each carries a `run(tuiApi)` the view
// calls on Enter; an empty list means there is nothing actionable to show.
export function extraProviderRows(ctx) {
  const engine = ctx.pluginByCapability("custom-endpoints");
  const state = customProviderState(engine, ctx.reposDir, { exists: ctx.exists, hasManager: ctx.hasManager });
  const label = customProviderLabel(state);
  if (!label) return [];

  if (state.kind === "install") {
    return [{
      id: "install-custom-providers",
      label,
      hint: "adds the plugin that serves your own endpoints",
      run: (tuiApi) => ctx.install(state.engine, tuiApi),
    }];
  }

  return [{
    id: "add-custom-provider",
    label,
    hint: "an endpoint of your own, served as its own provider",
    run: (tuiApi) => ctx.openAction(addCustomProviderAction(state.engine, {
      getConfigValue: ctx.getConfigValue,
      setConfigValue: ctx.setConfigValue,
      // The plugin stores the key and re-materialises its own provider manifest; the loader
      // only says which plugin to ask.
      applyEndpoint: (endpoint, key) => ctx.applyEndpoint(state.engine, endpoint, key),
    }), tuiApi, label),
  }];
}
