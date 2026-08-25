import { setDiagnosticSink } from "@intisy-ai/api/engine";
import type { ActionResult, CapabilitySchema, SectionSpec } from "./capability-shapes.js";
import type { ScreenNode, ScreenSpec } from "./screens.js";
import { APP_ID, PLUGINS_DIR, CONFIG_DIR, tuiLog } from "./env.js";
import { S } from "./state.js";
import {
  applyManifestDeclarations, createPluginRuntime,
  ACCOUNTS, ACTIVITY, CUSTOM_ENDPOINTS, PLUGIN_MANAGEMENT, ROUTING, SCREENS, SETTINGS,
} from "@intisy-ai/core";
import { callCapability, DEFAULT_CALL_TIMEOUT_MS, DEFAULT_INVOKE_TIMEOUT_MS, ledgerRows, readDeployedManifests, startPlugins } from "@intisy-ai/api/host";
import type { LoadedHost, PluginLedgerRow } from "@intisy-ai/api/host";
import type { CapabilityType } from "@intisy-ai/api/contract";

let HOST: LoadedHost | null = null;

/** One plugin's implementation of a capability, as a surface consumes it. */
export interface Provider {
  /** The plugin that provided it. */
  pluginId: string;
  /** The implementation itself. */
  implementation: unknown;
}

/**
 * The capabilities this host renders, which the engine verifies a plugin's declarations against.
 *
 * @remarks
 * Deliberately narrower than everything core mints: the api holds a host to the ids it names, which
 * is what turns the check into "does THIS host understand it". A capability minted elsewhere in the
 * ecosystem but rendered by no surface here is unknown to this host, and saying so is the point.
 */
const RENDERED_CAPABILITIES = [SCREENS, SETTINGS, CUSTOM_ENDPOINTS, PLUGIN_MANAGEMENT];

/**
 * The bare service ids any plugin may register under.
 *
 * @remarks
 * An absent list means an EMPTY one here, the opposite of the capability vocabulary above, so naming
 * these is what lets a plugin claim the shared contract instead of being read as squatting on it.
 */
const WELL_KNOWN_SERVICES = [ACCOUNTS, ROUTING, ACTIVITY];

/**
 * The services the loader implements on every plugin's behalf.
 *
 * @remarks
 * Injected, because a plugin reaching behaviour from a library it may not link gets it from the
 * host, and this library may not link that library either: `provider-support` belongs to core-auth,
 * which sits in this library's own layer. An entry missing an id or an implementation is dropped
 * rather than passed on, since the host would register a service nothing can call.
 */
export function hostServices(capabilities: unknown): ReadonlyArray<{ id: string; implementation: unknown }> {
  const value = (capabilities as Record<string, unknown> | undefined)?.services;
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => {
    const service = entry as { id?: unknown; implementation?: unknown } | null;
    return !!service && typeof service.id === "string" && service.implementation !== undefined;
  }) as ReadonlyArray<{ id: string; implementation: unknown }>;
}

/**
 * Starts the in-process plugin host for this home.
 *
 * @remarks
 * With no home resolved there is no host, and every surface below answers empty rather than
 * failing, which is the same degradation rule the rest of the plugin system follows.
 *
 * The diagnostic sink is installed first: the engine's fallback for an ignored unknown id writes to
 * the console, and anything written to the terminal corrupts this TUI.
 */
export async function startPluginHost(): Promise<void> {
  if (HOST) return;
  setDiagnosticSink((message: string) => tuiLog("[plugin-api] " + message));
  // Before the home guard: a slash command is a file the APP reads, so it must be written whatever
  // becomes of the host.
  applyDeclarations();
  if (!CONFIG_DIR) {
    tuiLog("no app home resolved; plugin screens and settings stay empty");
    return;
  }
  try {
    HOST = await startPlugins({
      app: APP_ID,
      pluginDir: PLUGINS_DIR,
      surfaces: ["tui"],
      vocabulary: RENDERED_CAPABILITIES,
      wellKnownServices: WELL_KNOWN_SERVICES,
      services: hostServices(S.capabilities),
      runtimeFor: (manifest) => createPluginRuntime(manifest.id, CONFIG_DIR),
    });
    for (const error of HOST.quarantined) {
      tuiLog("plugin " + error.pluginId + " quarantined: " + error.detail + " (fix: " + error.fix + ")", true);
    }
  } catch (error) {
    tuiLog("plugin host failed to start: " + String(error), true);
  }
}

/**
 * Registers each deployed plugin's declared settings and commands.
 *
 * @remarks
 * Before the host starts, and whatever the host then makes of a plugin: a settings row and a slash
 * command are things a plugin DECLARES, so they must exist for one that is broken, disabled, or has
 * simply never been activated.
 */
function applyDeclarations(): void {
  try {
    const scan = readDeployedManifests(PLUGINS_DIR, WELL_KNOWN_SERVICES);
    applyManifestDeclarations(scan.loaded.map((plugin) => plugin.manifest), CONFIG_DIR);
  } catch (error) {
    tuiLog("could not register what the installed plugins declare: " + String(error), true);
  }
}

/** The running host, or `null` when none started. */
export function pluginHost(): LoadedHost | null {
  return HOST;
}

/**
 * Replaces the running host. Tests only.
 *
 * @remarks
 * Clearing the host also uninstalls the diagnostic sink `startPluginHost` installed, so a later api
 * diagnostic cannot keep writing through a logger whose home the next test never pinned.
 */
export function resetPluginHostForTests(host: LoadedHost | null): void {
  HOST = host;
  if (!host) setDiagnosticSink(null);
}

/** Every plugin providing a capability, in activation order. */
export function capabilityProviders(id: string): Provider[] {
  if (!HOST) return [];
  return HOST.host.capability(id).map((record) => ({ pluginId: record.pluginId, implementation: record.implementation }));
}

/** The plugin ids providing a capability, in activation order. */
export function providerIds(type: CapabilityType<unknown>): string[] {
  return capabilityProviders(type.id).map((provider) => provider.pluginId);
}

/**
 * One plugin's implementation of a capability, or `undefined` when it provides none.
 *
 * @remarks
 * Takes the minting library's typed key rather than a bare id, so the id and the shape it implies
 * cannot be paired wrongly: the phantom on the key makes that a compile error, where a literal
 * beside a cast made it a silent `undefined` at run time.
 */
export function capabilityOf<T>(pluginId: string, type: CapabilityType<T>): T | undefined {
  return capabilityProviders(type.id).find((provider) => provider.pluginId === pluginId)?.implementation as T | undefined;
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

function isFilledString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

// A capability answers with a live object this library never serialized, so every surface below is
// reading whatever the plugin's function happened to return. Validating once here is what lets each
// consumer walk a spec without re-checking it, and what keeps an authoring mistake from reaching a
// renderer that assumes the declared shape.
function screenSpecProblem(spec: unknown): string | null {
  if (!spec || typeof spec !== "object") return "not an object";
  const declared = spec as Partial<ScreenSpec>;
  if (!isFilledString(declared.id)) return "no id";
  if (!isFilledString(declared.label)) return "no label";
  if (!declared.layout || typeof declared.layout !== "object") return "no layout";
  if (!isFilledString((declared.layout as ScreenNode).kind)) return "a layout with no kind";
  return null;
}

function listOf<T>(value: unknown, what: string, pluginId: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value !== undefined) tuiLog("ignored " + what + " from " + pluginId + ": not a list");
  return [];
}

/**
 * The screens a plugin contributes, or an empty list when it contributes none or fails to answer.
 *
 * @remarks
 * A screen a surface could not render is dropped here with a diagnostic naming the plugin, so an
 * author whose screen never appears finds out why from the log rather than from an empty sub-page.
 */
export async function readScreenSpecs(pluginId: string): Promise<ScreenSpec[]> {
  const screens = capabilityOf(pluginId, SCREENS);
  if (!screens) return [];
  const answer = await callCapability(pluginId, "screens.screens", DEFAULT_CALL_TIMEOUT_MS, async () => screens.screens());
  if (answer.ok === false) {
    tuiLog("screens declaration from " + pluginId + " failed: " + answer.error.detail, true);
    return [];
  }
  const kept: ScreenSpec[] = [];
  for (const spec of listOf<ScreenSpec>(answer.value, "the screens declaration", pluginId)) {
    const problem = screenSpecProblem(spec);
    if (problem === null) { kept.push(spec); continue; }
    const named = spec && typeof spec === "object" && isFilledString(spec.id) ? ' "' + spec.id + '"' : "";
    tuiLog("ignored screen" + named + " from " + pluginId + ": " + problem);
  }
  return kept;
}

/** The data behind one of a plugin's screens, or `null` when it could not be read. */
export async function readScreenData(pluginId: string, screenId: string): Promise<Record<string, unknown> | null> {
  const screens = capabilityOf(pluginId, SCREENS);
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
  const screens = capabilityOf(pluginId, SCREENS);
  if (!screens) return { ok: false, message: "plugin not available" };
  const answer = await callCapability(pluginId, "screens.invoke", DEFAULT_INVOKE_TIMEOUT_MS, async () =>
    screens.invoke({ screenId, actionId, home: CONFIG_DIR, input }));
  if (answer.ok === false) {
    tuiLog("screen action " + actionId + " failed: " + answer.error.detail, true);
    return { ok: false, message: answer.error.detail };
  }
  return answer.value ?? { ok: true };
}

/**
 * What a plugin declares on a settings surface, or `null` when it declares nothing readable.
 *
 * @remarks
 * `fields`, `actions` and `sections` always come back as arrays, each section's own `fields` and
 * `actions` included, so a consumer iterating one cannot throw on a plugin that declared something
 * else there.
 */
export async function readSettingsSchema(pluginId: string): Promise<CapabilitySchema | null> {
  const settings = capabilityOf(pluginId, SETTINGS);
  if (!settings) return null;
  const answer = await callCapability(pluginId, "settings.schema", DEFAULT_CALL_TIMEOUT_MS, async () => settings.schema());
  if (answer.ok === false) {
    tuiLog("settings declaration from " + pluginId + " failed: " + answer.error.detail, true);
    return null;
  }
  const declared = answer.value;
  if (!declared || typeof declared !== "object") return null;
  const sections = listOf<SectionSpec>(declared.sections, "a section list", pluginId)
    .filter((section) => section && typeof section === "object")
    .map((section) => ({
      ...section,
      fields: listOf<string>(section.fields, 'section "' + section.id + '" fields', pluginId),
      actions: listOf<string>(section.actions, 'section "' + section.id + '" actions', pluginId),
    }));
  return {
    ...declared,
    fields: listOf(declared.fields, "a field list", pluginId),
    actions: listOf(declared.actions, "an action list", pluginId),
    sections,
  };
}

/**
 * Runs one of a plugin's declared settings actions.
 *
 * @remarks
 * `input` carries what the action declared under `args` and a surface collected. Passed through the
 * contract's second `run` overload only when there is something to pass, so an action taking none is
 * still called the way it declares itself.
 */
export async function runSettingsAction(pluginId: string, actionId: string, input?: Record<string, unknown>): Promise<ActionResult> {
  const settings = capabilityOf(pluginId, SETTINGS);
  if (!settings) return { ok: false, message: "plugin not available" };
  const answer = await callCapability(pluginId, "settings.run", DEFAULT_INVOKE_TIMEOUT_MS, async () =>
    input ? settings.run(actionId, input) : settings.run(actionId));
  if (answer.ok === false) return { ok: false, message: answer.error.detail };
  return answer.value ?? { ok: true };
}
