import { setDiagnosticSink } from "@intisy-ai/api";
import type { ActionResult, CapabilitySchema, ScreenSpec, ScreensCapability, SettingsCapability } from "@intisy-ai/api";
import { IS_CLAUDE, PLUGINS_DIR, CONFIG_DIR, tuiLog } from "./env.js";
import { S } from "./state.js";
import { callCapability, DEFAULT_CALL_TIMEOUT_MS, DEFAULT_INVOKE_TIMEOUT_MS, ledgerRows, startPlugins } from "./plugin-host.js";
import type { LoadedHost, LoaderHostOptions, PluginLedgerRow } from "./plugin-host.js";

let HOST: LoadedHost | null = null;

/** One plugin's implementation of a capability, as a surface consumes it. */
export interface Provider {
  /** The plugin that provided it. */
  pluginId: string;
  /** The implementation itself. */
  implementation: unknown;
}

/**
 * Starts the in-process plugin host for this home.
 *
 * @remarks
 * The per-plugin runtime is injected, because this library carries no core submodule and cannot
 * build one; the loader that does registers `runtimeFor` alongside its other capabilities. With
 * nothing injected there is no host, and every surface below answers empty rather than failing,
 * which is the same degradation rule the rest of the plugin system follows.
 *
 * The diagnostic sink is installed first: api reports an ignored unknown id through
 * `reportDiagnostic`, whose fallback writes to the console, and anything written to the terminal
 * corrupts this TUI.
 */
export async function startPluginHost(): Promise<void> {
  if (HOST) return;
  setDiagnosticSink((message: string) => tuiLog("[plugin-api] " + message));
  const runtimeFor = (S.capabilities as Record<string, unknown> | undefined)?.runtimeFor;
  if (typeof runtimeFor !== "function") {
    tuiLog("no plugin runtime registered; plugin screens and settings stay empty");
    return;
  }
  try {
    HOST = await startPlugins({
      app: IS_CLAUDE ? "claude" : "opencode",
      pluginDir: PLUGINS_DIR,
      surfaces: ["tui"],
      runtimeFor: runtimeFor as LoaderHostOptions["runtimeFor"],
    });
    for (const error of HOST.quarantined) {
      tuiLog("plugin " + error.pluginId + " quarantined: " + error.detail + " (fix: " + error.fix + ")", true);
    }
  } catch (error) {
    tuiLog("plugin host failed to start: " + String(error), true);
  }
}

/** The running host, or `null` when none started. */
export function pluginHost(): LoadedHost | null {
  return HOST;
}

/** Replaces the running host. Tests only. */
export function resetPluginHostForTests(host: LoadedHost | null): void {
  HOST = host;
}

/** Every plugin providing a capability, in activation order. */
export function capabilityProviders(id: string): Provider[] {
  if (!HOST) return [];
  return HOST.host.capability(id).map((record) => ({ pluginId: record.pluginId, implementation: record.implementation }));
}

/** The plugin ids providing a capability, in activation order. */
export function providerIds(id: string): string[] {
  return capabilityProviders(id).map((provider) => provider.pluginId);
}

/** One plugin's implementation of a capability, or `undefined` when it provides none. */
export function capabilityOf(pluginId: string, id: string): unknown {
  return capabilityProviders(id).find((provider) => provider.pluginId === pluginId)?.implementation;
}

/** The deployed bundle of a plugin, or `null` when none is deployed beside its manifest. */
export function bundleFor(pluginId: string): string | null {
  if (!HOST) return null;
  return HOST.deployed.find((plugin) => plugin.manifest.id === pluginId)?.entryPath ?? null;
}

/** One plugin's whole relationship record, or `null` when the host never saw it. */
export function ledgerRowFor(pluginId: string): PluginLedgerRow | null {
  if (!HOST) return null;
  return ledgerRows(HOST).find((row) => row.pluginId === pluginId) ?? null;
}

/** The screens a plugin contributes, or an empty list when it contributes none or fails to answer. */
export async function readScreenSpecs(pluginId: string): Promise<ScreenSpec[]> {
  const screens = capabilityOf(pluginId, "screens") as ScreensCapability | undefined;
  if (!screens) return [];
  const answer = await callCapability(pluginId, "screens.screens", DEFAULT_CALL_TIMEOUT_MS, async () => screens.screens());
  if (answer.ok === false) {
    tuiLog("screens declaration from " + pluginId + " failed: " + answer.error.detail, true);
    return [];
  }
  return Array.isArray(answer.value) ? answer.value : [];
}

/** The data behind one of a plugin's screens, or `null` when it could not be read. */
export async function readScreenData(pluginId: string, screenId: string): Promise<Record<string, unknown> | null> {
  const screens = capabilityOf(pluginId, "screens") as ScreensCapability | undefined;
  if (!screens) return null;
  const answer = await callCapability(pluginId, "screens.read", DEFAULT_CALL_TIMEOUT_MS, async () =>
    screens.read({ screenId, home: CONFIG_DIR }));
  if (answer.ok === false) {
    tuiLog("screen " + pluginId + ":" + screenId + " read failed: " + answer.error.detail, true);
    return null;
  }
  return (answer.value?.sources as Record<string, unknown>) ?? {};
}

/**
 * Runs one of a screen's actions.
 *
 * @remarks
 * The invoke budget, not the read one: an action may do real work such as a multi-file restore, and
 * a read-length deadline would abandon it mid-write.
 */
export async function invokeScreenAction(
  pluginId: string,
  screenId: string,
  actionId: string,
  input: Record<string, unknown>,
): Promise<ActionResult> {
  const screens = capabilityOf(pluginId, "screens") as ScreensCapability | undefined;
  if (!screens) return { ok: false, message: "plugin not available" };
  const answer = await callCapability(pluginId, "screens.invoke", DEFAULT_INVOKE_TIMEOUT_MS, async () =>
    screens.invoke({ screenId, actionId, home: CONFIG_DIR, input }));
  if (answer.ok === false) {
    tuiLog("screen action " + actionId + " failed: " + answer.error.detail, true);
    return { ok: false, message: answer.error.detail };
  }
  return answer.value ?? { ok: true };
}

/** What a plugin declares on a settings surface, or `null` when it declares nothing readable. */
export async function readSettingsSchema(pluginId: string): Promise<CapabilitySchema | null> {
  const settings = capabilityOf(pluginId, "settings") as SettingsCapability | undefined;
  if (!settings) return null;
  const answer = await callCapability(pluginId, "settings.schema", DEFAULT_CALL_TIMEOUT_MS, async () => settings.schema());
  if (answer.ok === false) {
    tuiLog("settings declaration from " + pluginId + " failed: " + answer.error.detail, true);
    return null;
  }
  return answer.value ?? null;
}

/** Runs one of a plugin's declared settings actions. */
export async function runSettingsAction(pluginId: string, actionId: string): Promise<ActionResult> {
  const settings = capabilityOf(pluginId, "settings") as SettingsCapability | undefined;
  if (!settings) return { ok: false, message: "plugin not available" };
  const answer = await callCapability(pluginId, "settings.run", DEFAULT_INVOKE_TIMEOUT_MS, async () => settings.run(actionId));
  if (answer.ok === false) return { ok: false, message: answer.error.detail };
  return answer.value ?? { ok: true };
}
