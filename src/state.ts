// Single source of mutable TUI state. ESM live bindings can't be reassigned
// across modules, so every shared mutable value lives here as a property of S
// and is mutated in place (S.cursor = 0), never reassigned as a bare binding.

import type { FieldSpec } from "./capability-shapes.js";
import type { LoaderCapabilities, McpServerDraft } from "./app-capabilities.js";
import type { CustomTab } from "./custom-tab.js";
import type { CatalogEntry } from "./capability-catalog.js";
import type { PluginManagerModule, PluginManagerRef } from "./plugin-manager.js";
import type { ProjectItem } from "./projects.js";
import type { CommitRow, PluginRow } from "./plugins.js";
import type { MarketplaceRow } from "./marketplace.js";
import type { McpRow } from "./mcp.js";
import type { ScreenEntry, ScreenRow } from "./screens.js";
import type { ConfigTarget, SettingsEntry, SettingsRow, SettingsSection } from "./settings-model.js";
import type { SessionEntry } from "./app-capabilities.js";

/** One seeded marketplace's fetched state, or the reason it could not be read. */
export interface SeedMarketplace {
  /** The plugins its manifest offers. */
  plugins?: MarketplaceRow[];
  /** How many, which is what the level-1 row shows. */
  count?: number;
  /** The `owner/repo` it was read from. */
  repo?: string;
  /** Why the read failed, when it did. */
  error?: string;
}

/** A declared action's arguments, collected one at a time before the action runs. */
export interface ConfigActionArgs {
  /** The action being armed. */
  key: string;
  /** What that action is shown as. */
  label: string;
  /** The arguments it declared. */
  specs: FieldSpec[];
  /** What has been collected so far. */
  values: Record<string, unknown>;
  /** Which argument is being collected. */
  at: number;
}

/** What a confirm dialog is about to do, and to what. */
export type ConfirmAction =
  | { type: "uninstall-npm" | "uninstall-plugin" | "uninstall-foreign"; target: PluginRow }
  | { type: "uninstall-mcp"; target: string }
  | { type: "screen-action"; target: { entry: ScreenEntry; row: ScreenRow } };

/**
 * Every mutable value the terminal UI shares between its modules.
 *
 * @remarks
 * One object rather than a module per page, because ESM live bindings cannot be reassigned across
 * modules: a bare exported `let` would be read as its initial value everywhere but the module that
 * wrote it.
 */
export interface LoaderState {
  /** A gate that swallows keys until it is cleared, named by what it is gating. */
  globalKeyHandler: string | null;
  /** The resolved plugin-manager module, `null` once resolution ran and found none. */
  UPDATER_MODULE: PluginManagerModule | null | undefined;
  /** The resolved manager's package directory, which is where its version is read from. */
  UPDATER_PATH: string | undefined;
  /** The manager's entry module, which is what a child process imports to run an update off-thread. */
  UPDATER_ENTRY: string | undefined;
  /** The global npm root, `null` until it has been asked for and `""` when npm could not answer. */
  NPM_GLOBAL_ROOT: string | null;

  /** The tabs plugins contributed at startup. */
  customTabs: CustomTab[];
  /** What the active loader can do, registered at boot. */
  capabilities: LoaderCapabilities;

  /** The community catalog, filled in by the async GitHub and npm searches. */
  MARKETPLACE_CATALOG: MarketplaceRow[];
  /** Whether that fetch has run this session. */
  catalogFetched: boolean;
  /** How many of its requests are still in flight. */
  catalogPending: number;
  /** Each seeded marketplace's fetched state, by name. An absent key means not fetched yet. */
  seedMarketplaces: Record<string, SeedMarketplace>;
  /** Whether the seed fetch has run this session. */
  seedFetched: boolean;
  /** What this home's declared sources offer, `null` while that has not been read. */
  sourceCatalog: CatalogEntry[] | null;
  /** Whether the source fetch has run this session. */
  sourceFetched: boolean;

  /** The Projects list. */
  items: ProjectItem[];
  /** The cursor within whichever list the active page shows. */
  cursor: number;
  /** The cursor within the open action menu. */
  acursor: number;
  /** How far the Projects list is scrolled. */
  scrollOff: number;
  /** How keys are routed: `list`, a named dialog, or a text-input mode. */
  mode: string;
  /** Which page is showing. */
  page: string;
  /** What has been typed into the active search or input line. */
  inputBuf: string;
  /** The directory a change-path action is rewriting. */
  chpathDir: string;

  /** The chosen project's earlier sessions, present only while the session picker is open. */
  sessionItems: SessionEntry[];
  /** The cursor within them, where row 0 is "new session". */
  scursor: number;
  /** The project directory being opened. */
  sessionDir: string;
  /** Whether the picker was reached via "Open here", which the wrapper's arg forwarding depends on. */
  sessionHere: boolean;

  /** The Plugins list: git clones, npm plugins and the host app's own, in one array. */
  pluginItems: PluginRow[];
  /** The cursor within it. */
  pcursor: number;
  /** The cursor within the open plugin action menu. */
  pacursor: number;
  /** How far the list is scrolled. */
  pscrollOff: number;
  /** Whether the remote-update fetch has run this session. */
  pluginFetched: boolean;
  /** The plugin an update is currently running for. */
  pluginUpdating: string;
  /** Which sub-tab of the Plugins page is showing: a built-in one or a contributed tab's id. */
  pluginSubPage: string;
  /** The commit log of the plugin whose history is open. */
  commitItems: CommitRow[];
  /** The cursor within it. */
  ccursor: number;
  /** How far it is scrolled. */
  cscrollOff: number;

  /** The rows the config editor is showing. */
  configItems: SettingsRow[];
  /** The cursor within them. */
  cfgcursor: number;
  /** How far they are scrolled. */
  cfgScrollOff: number;
  /** What is being edited, and how it is written back. */
  configTarget: ConfigTarget | null;
  /** The key whose value is being typed. */
  configEditKey: string;
  /** The action row armed by a first enter, waiting for the confirming second one. */
  configConfirm: string | null;
  /** The arguments being collected for a declared action, `null` whenever none is collecting. */
  configActionArgs: ConfigActionArgs | null;
  /**
   * The one config row whose secret value is currently shown, by key.
   *
   * @remarks
   * Cleared by moving the cursor or leaving the editor, so a revealed secret never survives a
   * navigation.
   */
  cfgReveal: string;

  /** The Activity feed, as the injected reader last returned it. */
  activityRecords: Record<string, unknown>[];
  /** The cursor within it. */
  activityCursor: number;
  /** Which impacts the feed is narrowed to; empty means every impact. */
  activityImpacts: string[];
  /** How far it is scrolled. */
  activityScrollOff: number;

  /** The MCP list. */
  mcpItems: McpRow[];
  /** The cursor within it. */
  mcpCursor: number;
  /** How far it is scrolled. */
  mcpScrollOff: number;
  /** Which sub-tab of the MCP page is showing. */
  mcpSubPage: string;
  /** Which MCP list is being browsed. */
  mcpMode: string;
  /** The cursor within the open MCP action menu. */
  mcpAcursor: number;
  /** Which field of the add-server flow is being collected: 0 name, 1 transport, 2 target. */
  mcpAddStep: number;
  /** What that flow has collected so far. */
  mcpAddDraft: McpServerDraft | null;

  /** The cursor within the Settings page. */
  settingsCursor: number;
  /** How far it is scrolled. */
  settingsScrollOff: number;
  /** Which Settings sub-tab is showing: `settings`, or a `<plugin>:<screenId>` a plugin contributed. */
  settingsSubPage: string;
  /** The global section plus one per plugin. */
  settingsSections: SettingsSection[];
  /** The flat rows the renderer and the key handler both walk: headers and groups. */
  settingsEntries: SettingsEntry[];

  /** The screens plugins contributed, read once because the sub-page list is walked every frame. */
  screenSpecs: ScreenEntry[];
  /** The active screen, flattened to rows. */
  screenRows: ScreenRow[];
  /** The cursor within them. */
  screenCursor: number;
  /** How far they are scrolled. */
  screenScrollOff: number;
  /**
   * The sub-page id whose last read failed.
   *
   * @remarks
   * An empty screen then renders as unreadable rather than as forever loading. Cleared by the next
   * read that lands.
   */
  screenFailed: string | null;

  /** Whichever level of the marketplace browser is active. */
  marketplaceItems: MarketplaceRow[];
  /** The cursor within it. */
  mkCursor: number;
  /** How far it is scrolled. */
  mkScrollOff: number;
  /** Whether the browser is listing or acting. */
  mkMode: string;
  /** The cursor within the open marketplace action menu. */
  mkAcursor: number;
  /** Which rows a multi-install has selected, by name. */
  mkSelected: Record<string, boolean>;
  /** Which level is showing: the marketplaces themselves, or one marketplace's plugins. */
  mkLevel: string;
  /** The marketplace drilled into. */
  mkMarket: string | null;
  /**
   * That marketplace's kind, captured from its level-1 row.
   *
   * @remarks
   * The level-2 builder routes on THIS rather than on comparing the display name, because a
   * capability marketplace could share a built-in name and would otherwise be misrouted.
   */
  mkMarketKind: string | null;
  /** The declared source a level-2 list is showing, since a source is identified by id and labelled by name. */
  mkMarketSourceId: string | null;
  /** Which leading action row is being confirmed while a marketplace input is open. */
  mkAddAction: string | null;

  /** What the open confirm dialog will do. */
  confirmAction: ConfirmAction | null;
  /** The question it asks. */
  confirmLabel: string;
  /** Which answer is selected. */
  confirmCursor: number;

  /**
   * True while an off-thread install or update runs.
   *
   * @remarks
   * Blocks all key handling, so the user stays put and cannot fire more work on top of it.
   */
  busy: boolean;
  /**
   * Whether a plugin manager was found in this home.
   *
   * @remarks
   * The check reads disk and can import a bundle, so it must never run on a navigation render:
   * computed until true, then held.
   */
  hasUpdater: boolean;
  /** The manager this home resolved: `undefined` before resolution ran, `null` when it found none. */
  pluginManager: PluginManagerRef | null | undefined;

  /** The status line's current message. */
  message: string;
  /** When it clears. */
  msgTimeout: ReturnType<typeof setTimeout> | null;
  /** The pending redraw. */
  renderTimer: ReturnType<typeof setTimeout> | null;
  /** Which frame of the spinner is showing. */
  spinnerTick: number;
  /** The spinner's own timer. */
  spinnerTimer: ReturnType<typeof setInterval> | null;
  /** Whether the help overlay is open. */
  helpOpen: boolean;

  /** The stderr output buffer. */
  _buf: string;
}

/** The one shared state object every module in this UI reads and mutates. */
export const S: LoaderState = {
  globalKeyHandler: null,
  UPDATER_MODULE: undefined,
  UPDATER_PATH: "",
  UPDATER_ENTRY: undefined,
  NPM_GLOBAL_ROOT: null,

  customTabs: [],
  capabilities: {},

  MARKETPLACE_CATALOG: [],
  catalogFetched: false,
  catalogPending: 0,
  seedMarketplaces: {},
  seedFetched: false,
  sourceCatalog: null,
  sourceFetched: false,

  items: [],
  cursor: 0,
  acursor: 0,
  scrollOff: 0,
  mode: "list",
  page: "projects",
  inputBuf: "",
  chpathDir: "",

  sessionItems: [],
  scursor: 0,
  sessionDir: "",
  sessionHere: false,

  pluginItems: [],
  pcursor: 0,
  pacursor: 0,
  pscrollOff: 0,
  pluginFetched: false,
  pluginUpdating: "",
  pluginSubPage: "installed",
  commitItems: [],
  ccursor: 0,
  cscrollOff: 0,

  configItems: [],
  cfgcursor: 0,
  cfgScrollOff: 0,
  configTarget: null,
  configEditKey: "",
  configConfirm: null,
  configActionArgs: null,
  cfgReveal: "",

  activityRecords: [],
  activityCursor: 0,
  activityImpacts: [],
  activityScrollOff: 0,

  mcpItems: [],
  mcpCursor: 0,
  mcpScrollOff: 0,
  mcpSubPage: "installed",
  mcpMode: "catalog",
  mcpAcursor: 0,
  mcpAddStep: 0,
  mcpAddDraft: null,

  settingsCursor: 0,
  settingsScrollOff: 0,
  settingsSubPage: "settings",
  settingsSections: [],
  settingsEntries: [],

  screenSpecs: [],
  screenRows: [],
  screenCursor: 0,
  screenScrollOff: 0,
  screenFailed: null,

  marketplaceItems: [],
  mkCursor: 0,
  mkScrollOff: 0,
  mkMode: "browse",
  mkAcursor: 0,
  mkSelected: {},
  mkLevel: "markets",
  mkMarket: null,
  mkMarketKind: null,
  mkMarketSourceId: null,
  mkAddAction: null,

  confirmAction: null,
  confirmLabel: "",
  confirmCursor: 0,

  busy: false,
  hasUpdater: false,
  pluginManager: undefined,

  message: "",
  msgTimeout: null,
  renderTimer: null,
  spinnerTick: 0,
  spinnerTimer: null,
  helpOpen: false,

  _buf: "",
};
