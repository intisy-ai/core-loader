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

  // Plugin config editor (Plugins tab -> Configure). Detected per-plugin by probing
  // its deployed bundle with `config schema`; editing writes via `config set`.
  configItems: [],
  cfgcursor: 0,
  cfgScrollOff: 0,
  configTarget: null,
  configEditKey: "",
  // the action row armed by a first enter, waiting for the confirming second one
  configConfirm: null,

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
  // "settings" | "versioning" | "<plugin>:<screenId>", sub-tabs of the Settings tab (Tab
  // cycles). "versioning" is the one hardcoded sub-page; every other non-"settings" id
  // names a screen a plugin contributed (see views/screens.ts).
  settingsSubPage: "settings",
  settingsSections: [],  // SettingsSection[] (Global + one per plugin)
  settingsEntries: [],   // SettingsEntry[] the renderer + key handler walk (headers + groups)

  // Contributed-screen sub-pages (views/screens.ts): the declarations each plugin's `screens`
  // capability answered, read once because the sub-page list is walked every render frame.
  screenSpecs: [],
  screenRows: [],
  screenCursor: 0,
  screenScrollOff: 0,

  // Versioning tab (config-ledger git UI). versioningCursor drives the home/setup menus;
  // the history file→key pickers use vg* fields; git sub-screens reuse the sg*/cl* fields.
  versioningCursor: 0,
  versioningScrollOff: 0,
  clInstalling: false,   // config-ledger install in progress → Versioning shows a spinner screen
  vgSections: [],        // sections (file + keys) for the history pickers
  vgFileCursor: 0,
  vgKeys: [],            // keys of the file chosen in the history picker
  vgKeyCursor: 0,
  vgHistFile: "",

  // config-ledger: cached lib module + git-data caches for the Settings tab
  CONFIG_LEDGER_MODULE: null,   // resolved dist/lib.js module, or null when absent
  clReady: false,            // cached configLedgerReady() (repo.isRepo spawns git; recomputed in refreshSettings, never per render frame)
  clDiffRows: [],            // last diffAgainstHead() rows (markers + review screen)
  clHistory: [],             // last keyHistory() rows (history sub-screen)
  clHistoryFile: "",         // file the history sub-screen is showing
  clHistoryKey: "",          // key the history sub-screen is showing
  clHistoryCursor: 0,
  clProfiles: [],            // profiles.list() snapshot
  clProfileCurrent: "",      // profiles.current()
  clProfileCursor: 0,
  sgMenuCursor: 0,           // cursor in the config-ledger action menu (sgmenu)
  sgSetupCursor: 0,          // cursor in the repo-setup menu (sgsetup)
  _sgSetupOpts: [],          // setup-screen options stashed by the renderer for the input handler

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
  // builtin/capability tag ("official" | "community" | "capability" | null).
  // buildMarketplacePluginsList() routes on THIS, not on comparing mkMarket's
  // display name to "intisy-ai (official)"/"community": a capability
  // marketplace could otherwise share one of those names and be misrouted.
  mkMarketKind: null,
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

  // Cached "is the updater plugin present" result. The check reads disk + can shell
  // out, so it must never run on a navigation render, computed until true, then held.
  hasUpdater: false,

  // Updater install progress (shown in-body while installUpdater runs). updaterSteps
  // accumulates step labels; all but the last render as done (✓), the last as active.
  updaterInstalling: false,
  updaterSteps: [],

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
