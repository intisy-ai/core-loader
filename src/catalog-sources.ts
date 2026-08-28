import { existsSync } from "fs";
import { join } from "path";
import { readJson } from "./json.js";
import type { HomePaths } from "./home-paths.js";

/** How a source is read: a GitHub owner's repositories, a published manifest, or a local file. */
export type MarketplaceSourceType = "github-org" | "manifest" | "local";

/** One marketplace a home declares. */
export interface MarketplaceSource {
  /** Its identity within this home, and its precedence key. */
  id: string;
  /** The name a surface shows. Defaults to the id. */
  label: string;
  /** How it is read. */
  type: MarketplaceSourceType;
  /** Whether it takes part in a query. Only an explicit `false` disables it. */
  enabled?: boolean;
  /**
   * The GitHub owner login, for a `github-org` source. An organisation or a personal account: the
   * type name predates the distinction, and both are listed.
   */
  org?: string;
  /** The manifest URL, for a `manifest` source. */
  url?: string;
  /** The file or directory, for a `local` source. */
  path?: string;
}

/**
 * The GitHub owner every home starts with.
 *
 * @remarks
 * An OWNER is a source, not a plugin name, which is what makes this constant legitimate where a
 * plugin's name would not be: it says where to look, never what to find. A home overrides it by
 * declaring its own sources.
 */
export const DEFAULT_MARKETPLACE_ORG = "intisy-ai";

const CONFIG_FILE = "marketplaces.json";

/** The source a home that declares none is read with. */
export function builtInSource(): MarketplaceSource {
  return {
    id: DEFAULT_MARKETPLACE_ORG,
    label: DEFAULT_MARKETPLACE_ORG,
    type: "github-org",
    enabled: true,
    org: DEFAULT_MARKETPLACE_ORG,
  };
}

function validSource(raw: unknown): MarketplaceSource | null {
  if (!raw || typeof raw !== "object") return null;
  const declared = raw as Record<string, unknown>;
  const id = typeof declared.id === "string" ? declared.id.trim() : "";
  const type = declared.type;
  if (!id) return null;
  if (type !== "github-org" && type !== "manifest" && type !== "local") return null;
  if (type === "github-org" && typeof declared.org !== "string") return null;
  if (type === "manifest" && typeof declared.url !== "string") return null;
  if (type === "local" && typeof declared.path !== "string") return null;
  const source: MarketplaceSource = {
    id,
    label: typeof declared.label === "string" && declared.label.trim() ? declared.label.trim() : id,
    type,
    enabled: declared.enabled !== false,
  };
  if (typeof declared.org === "string") source.org = declared.org;
  if (typeof declared.url === "string") source.url = declared.url;
  if (typeof declared.path === "string") source.path = declared.path;
  return source;
}

/**
 * The declared sources, or the built-in one when a home declares nothing usable.
 *
 * @remarks
 * A source naming no id, or no location for its type, is dropped rather than guessed at: a
 * half-declared source would fail every query with a reason that names the config rather than the
 * marketplace. An unknown type is ignored for the same reason the rest of this system ignores an
 * unknown id, so a source written for a later version of this loader costs nothing here.
 */
export function parseMarketplaceSources(raw: unknown): MarketplaceSource[] {
  if (!Array.isArray(raw)) return [builtInSource()];
  const sources = raw.map(validSource).filter((source): source is MarketplaceSource => source !== null);
  return sources.length > 0 ? sources : [builtInSource()];
}

/** The sources one home declares, read from `config/marketplaces.json`. */
export function readMarketplaceSources(paths: HomePaths): MarketplaceSource[] {
  const preferred = join(paths.configFolder, CONFIG_FILE);
  const fallback = join(paths.configDir, CONFIG_FILE);
  const file = existsSync(preferred) ? preferred : existsSync(fallback) ? fallback : null;
  const declared = file ? readJson(file) : null;
  return parseMarketplaceSources(declared && (declared as { sources?: unknown }).sources);
}
