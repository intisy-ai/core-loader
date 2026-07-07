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

  // Marketplace + MCP catalogs (mutated by async fetches)
  MARKETPLACE_CATALOG: [],
  catalogFetched: false,
  catalogPending: 0,

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

  // MCP page
  mcpItems: [],
  mcpCursor: 0,
  mcpScrollOff: 0,
  mcpSubPage: "installed",
  mcpMode: "catalog",
  mcpAcursor: 0,

  // Settings page (global settings editor)
  settingsCursor: 0,
  settingsScrollOff: 0,

  // Marketplace sub-page
  marketplaceItems: [],
  mkCursor: 0,
  mkScrollOff: 0,
  mkMode: "browse",
  mkAcursor: 0,
  mkSelected: {},

  // Confirm dialog
  confirmAction: null,
  confirmLabel: "",
  confirmCursor: 0,

  // Long-action gate: true while an off-thread install/update runs; blocks all
  // key handling (see handleKey) so the user stays put and can't fire more work.
  busy: false,

  // Cached "is the updater plugin present" result. The check reads disk + can shell
  // out, so it must never run on a navigation render — computed until true, then held.
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
