// What the ACTIVE loader injects at boot (see tui.ts registerCapabilities). Every member is
// optional because the generic UI renders a feature only when its key is present, which is what
// keeps this library free of app-specific logic: a host that cannot list sessions simply does not
// register listSessions, and the Projects page never offers them.

import type { FieldSpec } from "./capability-shapes.js";
import type { LoaderActivitySeam } from "./activity-seam.js";
import type { ActivityQuery, ActivityRecord } from "@intisy-ai/core";

/** What a capability answers when it was asked to change something. */
export interface CapabilityResult {
  /** Whether the change was made. */
  ok: boolean;
  /** Why it was not, when it was not. */
  error?: string;
}

/** One earlier session of a project, as the host app records them. */
export interface SessionEntry {
  /** The id the host resumes the session by. */
  id: string;
  /** What the session is shown as. */
  title: string;
  /** When it was last active, in epoch milliseconds. */
  lastUsed?: number;
}

/** One plugin the HOST APP manages itself, which this loader can only list and toggle. */
export interface ForeignPlugin {
  /** The plugin's name within its source. */
  name: string;
  /** The marketplace or registry it came from. */
  source: string;
  /** Whether the host currently loads it. Only an explicit `false` disables it. */
  enabled?: boolean;
  /** The version the host reports, when it reports one. */
  version?: string;
}

/** One marketplace the host app itself knows about. */
export interface CapabilityMarketplace {
  /** Its display name, and the key `marketplacePlugins` is asked with. */
  name: string;
  /** Where it came from: a git URL or an `owner/repo`. */
  source?: string;
  /** How many plugins it offers, when the host counts them. */
  count?: number;
}

/** One plugin offered by a marketplace the host app knows about. */
export interface CapabilityMarketplacePlugin {
  /** Its display name. */
  name: string;
  /** The id the host installs it by, when that differs from the name. */
  id?: string;
  /** One line about what it does. */
  description?: string;
  /** The marketplace it belongs to, when the host repeats it per entry. */
  source?: string;
}

/** One MCP server the host app has configured. */
export interface CapabilityMcpServer {
  /** The server's name. */
  name: string;
  /** How it is reached: `http`, `stdio`, or whatever else the host supports. */
  transport?: string;
  /** The URL or command, shown beside the name. */
  detail?: string;
}

/** A new MCP server being collected one field at a time by the add flow. */
export interface McpServerDraft {
  /** The name it will be configured under. */
  name: string;
  /** How it is reached, toggled rather than typed. */
  transport: string;
  /** The URL for an http server, or the command for a stdio one. */
  target: string;
}

/** The shared settings declaration a host injects so a key core adds needs no change here. */
export interface GlobalSettingsDeclaration {
  /** The default value of every shared setting. */
  defaults: Record<string, unknown>;
  /** How each one is edited. */
  fields?: FieldSpec[];
}

/** The Activity seam plus the read side the views need. */
export type ActivityCapability = LoaderActivitySeam & {
  /** The records to show, newest first, narrowed by the query. */
  read?: (query?: ActivityQuery) => ActivityRecord[];
};

/**
 * Everything the active loader can offer the generic terminal UI.
 *
 * @remarks
 * An absent member is the normal case, not a defect: this is how one UI serves apps with different
 * abilities without naming any of them. Every consumer therefore tests for the function before
 * calling it, and degrades to a message rather than to an empty screen.
 */
export interface LoaderCapabilities {
  /** The earlier sessions of one project directory. */
  listSessions?: (dir: string) => SessionEntry[];
  /** The plugins the host app manages itself. */
  foreignPlugins?: () => ForeignPlugin[];
  /** Enables or disables one host-managed plugin, addressed as `name@source`. */
  setForeignPluginEnabled?: (key: string, enabled: boolean) => CapabilityResult;
  /** Removes one host-managed plugin, addressed as `name@source`. */
  uninstallForeignPlugin?: (key: string) => CapabilityResult;
  /** The marketplaces the host app knows about. */
  marketplaces?: () => CapabilityMarketplace[];
  /** The plugins one of those marketplaces offers. */
  marketplacePlugins?: (marketName: string) => CapabilityMarketplacePlugin[];
  /** Registers a marketplace with the host app, by git URL or `owner/repo`. */
  addMarketplace?: (source: string) => CapabilityResult;
  /** Installs one plugin from a marketplace the host app has registered. */
  installAppPlugin?: (id: string, marketName: string) => CapabilityResult;
  /** The MCP servers the host app has configured. */
  mcpServers?: () => CapabilityMcpServer[];
  /** Configures a new MCP server with the host app. */
  addMcpServer?: (draft: McpServerDraft | null) => CapabilityResult;
  /** The Activity read side, and the write seam this library emits through. */
  activity?: ActivityCapability;
  /** Behaviour a plugin may not link for itself, offered to plugins by the host that started them. */
  services?: ReadonlyArray<{
    /** The service's key, which is what a plugin asks for. */
    id: string;
    /** What answers for it. */
    implementation: unknown;
  }>;
  /** Core's own declaration of the shared settings, injected so this library links no core to get it. */
  globalSettings?: GlobalSettingsDeclaration;
}
