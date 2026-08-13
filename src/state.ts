// @ts-nocheck
// Single source of mutable TUI state. ESM live bindings can't be reassigned
// across modules, so every shared mutable value lives here as a property of S
// and is mutated in place (S.cursor = 0), never reassigned as a bare binding.

export const S = {
  // Lazy-loaded module/path caches
  globalKeyHandler: null,
  UPDATER_MODULE: undefined,
  UPDATER_PATH: "",
  NPM_GLOBAL_ROOT: null,

  // Plugin extension tabs registered at startup
  customTabs: [],

  // App-specific feature implementations registered by the active loader's tui-extension
  // at boot (see tuiApi.registerCapabilities). Generic UI renders a feature only when its
  // key is present, so core-loader carries no app-specific logic for these features.
  capabilities: {},

  // Marketplace + MCP catalogs (mutated by async fetches)
  MARKETPLACE_CATALOG: [],
  catalogFetched: false,
  catalogPending: 0,

  // Seeded default marketplaces (env.ts DEFAULT_MARKETPLACES): name -> { plugins,
  // count, repo, error }, filled in by marketplace.ts's fetchSeedMarketplacesAsync.
  // Absent key = not fetched yet (Level 1 shows "…" for its count).
  seedMarketplaces: {},
  seedFetched: false,

  // The entries this home's DECLARED marketplace sources offer (see catalog-sources.ts and
  // capability-catalog.ts), filled in by marketplace.ts's fetchSourceCatalogAsync. `null` means not
  // read yet, so Level 1 shows a count of "…" rather than a wrong zero.
  sourceCatalog: null,
  sourceFetched: false,

  // Projects page
  items: [],
  cursor: 0,
  acursor: 0,
  scrollOff: 0,
  mode: "list",
  page: "projects",
  inputBuf: "",
  chpathDir: "",
  // Session picker sub-mode (Claude only): the chosen project's sessions,
  // the cursor within them, the dir being opened, and whether it was reached
  // via "Open here" (so a new session preserves the exit-42 arg-forwarding path).
  sessionItems: [],
  scursor: 0,
  sessionDir: "",
  sessionHere: false,

  // Plugins page
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

  // Plugin config editor (Plugins tab -> Configure). Rows come from the plugin's settings
  // declaration; editing writes through the plugin's own `config set`.
  configItems: [],
  cfgcursor: 0,
  cfgScrollOff: 0,
  configTarget: null,
  configEditKey: "",
  // the action row armed by a first enter, waiting for the confirming second one
  configConfirm: null,
  // The one config row whose secret value is currently shown, by key. Cleared by moving the cursor
  // or leaving the editor, so a revealed secret never survives a navigation.
  cfgReveal: "",

  // Activity page: read-only feed from the injected `capabilities.activity` reader.
  // activityRecords caches the last read() result; refreshed on tab entry and 'r'.
  activityRecords: [],
  activityCursor: 0,
  // narrows what the injected reader returns; empty means every impact
  activityImpacts: [],
  activityScrollOff: 0,

  // MCP page
  mcpItems: [],
  mcpCursor: 0,
  mcpScrollOff: 0,
  mcpSubPage: "installed",
  mcpMode: "catalog",
  mcpAcursor: 0,
  // "＋ Add MCP server" multi-step input (S.mode === "mcpaddinput"): step 0 = name,
  // 1 = transport (http|stdio, toggled not typed), 2 = target (URL or command).
  // See input.ts handleMcpAddInputData.
  mcpAddStep: 0,
  mcpAddDraft: null,

  // Settings page (unified global + per-plugin settings editor)
  settingsCursor: 0,
  settingsScrollOff: 0,
  // "settings" | "<plugin>:<screenId>", sub-tabs of the Settings tab (Tab cycles). Any
  // non-"settings" id names a screen a plugin contributed (see views/screens.ts).
  settingsSubPage: "settings",
  settingsSections: [],  // SettingsSection[] (Global + one per plugin)
  settingsEntries: [],   // SettingsEntry[] the renderer + key handler walk (headers + groups)

  // Contributed-screen sub-pages (views/screens.ts): the declarations each plugin's `screens`
  // capability answered, read once because the sub-page list is walked every render frame.
  screenSpecs: [],
  screenRows: [],
  screenCursor: 0,
  screenScrollOff: 0,
  // The sub-page id whose last read failed, so an empty screen renders as unreadable rather than
  // as forever loading. Cleared by the next read that lands.
  screenFailed: null,

  // Marketplace sub-page
  marketplaceItems: [],
  mkCursor: 0,
  mkScrollOff: 0,
  mkMode: "browse",
  mkAcursor: 0,
  mkSelected: {},
  // Two-level browser: "markets" (marketplaces themselves) | "plugins" (one
  // marketplace's plugins, named by mkMarket). S.marketplaceItems always holds
  // whichever level is active, see marketplace.ts buildMarketplaceList().
  mkLevel: "markets",
  mkMarket: null,
  // Kind of the drilled-in marketplace, captured from its Level-1 row's
  // builtin/capability tag: "source" | "community" | "featured" | "seed" |
  // "capability" | null. buildMarketplacePluginsList() routes on THIS, not on
  // comparing mkMarket's display name: a capability marketplace could
  // otherwise share a built-in name and be misrouted.
  mkMarketKind: null,
  // The declared source a Level-2 list is showing, captured off its Level-1 row, because a source is
  // identified by its id while the row is labelled by the source's own label.
  mkMarketSourceId: null,
  // Which leading action row is being confirmed while S.mode === "mkinput":
  // "add_plugin_url" | "add_marketplace" (see input.ts handleMarketplaceAddInputData).
  mkAddAction: null,

  // Confirm dialog
  confirmAction: null,
  confirmLabel: "",
  confirmCursor: 0,

  // Long-action gate: true while an off-thread install/update runs; blocks all
  // key handling (see handleKey) so the user stays put and can't fire more work.
  busy: false,

  // Cached "is the plugin manager present" result. The check reads disk + can import a bundle, so it
  // must never run on a navigation render: computed until true, then held.
  hasUpdater: false,

  // The plugin manager this home resolved (see plugin-manager.ts). `undefined` means resolution has
  // not run yet, `null` means it ran and nothing in this home manages plugins.
  pluginManager: undefined,

  // Status message + render scheduling
  message: "",
  msgTimeout: null,
  renderTimer: null,
  spinnerTick: 0,
  spinnerTimer: null,
  helpOpen: false,

  // stderr output buffer
  _buf: "",
};
