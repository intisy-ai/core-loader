// @ts-nocheck
// Environment: app identity, filesystem paths, static catalogs, and the file
// logger. All values here are read-only constants shared across modules.

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import officialPluginsData from "../data/official-plugins.json";

// plugin-updater runs its full update sequence on import and logs to the
// console; library mode limits it to the API so nothing prints over the TUI
process.env.PLUGIN_UPDATER_LIBRARY_MODE = "1";

export const HOME = homedir();
export const APP_NAME = process.env.HUB_APP_NAME || "OpenCode";
export const CLI_CMD = process.env.HUB_CLI_CMD || "opencode";
// Claude Code has no npm-plugin mechanism (npm plugins are an opencode.jsonc concept),
// so the loader hides the npm section + npm install option under Claude.
export const IS_CLAUDE = String(CLI_CMD).indexOf("claude") !== -1 || String(APP_NAME).indexOf("Claude") !== -1;
export const NPM_PKG = process.env.HUB_NPM_PKG || "opencode-ai";
// The plugin manager's package name. This library cannot ask core which plugin holds the
// plugin-management capability (a loader carries core, this does not), and a module cannot be
// resolved without its name anyway, so the name lives here once instead of in every call site.
export const PLUGIN_MANAGER_PACKAGE = "plugin-updater";
export const CONFIG_DIR = process.env.HUB_CONFIG_DIR || join(HOME, ".config", "opencode");

// The storage subdirectory names. core owns these (an app declares them in the
// registry and core's appPaths resolves them), but this library carries no core
// submodule, so the loader that does passes the resolved names down through the
// environment. Only a single path segment is accepted, matching core: a separator
// or a traversal would move storage outside the home it belongs to.
function subdir(envVar: string, fallback: string): string {
  const declared = (process.env[envVar] || "").trim();
  if (!declared || declared === "." || declared === ".." || /[\\/]/.test(declared)) return fallback;
  return declared;
}

export const REPOS_SUBDIR = subdir("HUB_REPOS_SUBDIR", "repos");
export const PLUGIN_SUBDIR = subdir("HUB_PLUGIN_SUBDIR", "plugin");
export const CACHE_SUBDIR = subdir("HUB_CACHE_SUBDIR", "cache");
export const CONFIG_SUBDIR = subdir("HUB_CONFIG_SUBDIR", "config");

export const CACHE_PKG_DIR = join(CONFIG_DIR, CACHE_SUBDIR, "node_modules");

// opencode keeps its session database in the XDG data dir, not the config dir
export const DB_PATH = [
  join(HOME, ".local", "share", "opencode", "opencode.db"),
  join(CONFIG_DIR, "opencode.db"),
].find(function(p) { return existsSync(p); }) || join(HOME, ".local", "share", "opencode", "opencode.db");
export const CONFIG_FOLDER = join(CONFIG_DIR, CONFIG_SUBDIR);
export const CACHE_DIR = join(CONFIG_DIR, CACHE_SUBDIR);
export const CONFIG_PATH = join(CONFIG_FOLDER, "oc-config.json");
export const UPDATE_CHECK_PATH = join(CACHE_DIR, "oc-last-update-check");
export const PLUGINS_JSON = join(CONFIG_FOLDER, "plugins.json");
export const REPOS_DIR = join(CONFIG_DIR, REPOS_SUBDIR);
export const PLUGINS_DIR = join(CONFIG_DIR, PLUGIN_SUBDIR);
export const MCP_CONFIG_PATH = join(CONFIG_DIR, ".mcp.json");
export const CATALOG_CACHE_PATH = join(CACHE_DIR, "marketplace-catalog.json");
export const SEED_CACHE_PATH = join(CACHE_DIR, "seed-marketplaces.json");

// anything printed to the terminal corrupts the TUI, diagnostics go to a file
export const TUI_START_TIME = new Date().toISOString().replace(/:/g, "-").split(".")[0];
// isError just tags the line for grep-ability -- never mirrored to stderr (see above).
export function tuiLog(msg, isError?) {
  try {
    var dateStr = new Date().toISOString().split("T")[0];
    var logsDir = join(CONFIG_DIR, "logs", dateStr);
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    require("fs").appendFileSync(join(logsDir, "loader-tui-" + TUI_START_TIME + ".log"),
      "[" + new Date().toISOString() + "]" + (isError ? " [ERROR]" : "") + " " + msg + "\n");
  } catch {}
}

// MCP Server Catalog (curated, verified packages)
export const MCP_CATALOG = [
  // Search & Research
  { name: "brave-search", desc: "Web search via Brave API", command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"], env: { BRAVE_API_KEY: "" }, category: "Search" },
  { name: "exa", desc: "AI-powered semantic search", command: "npx", args: ["-y", "exa-mcp-server"], env: { EXA_API_KEY: "" }, category: "Search" },
  { name: "tavily", desc: "AI search engine for agents", command: "npx", args: ["-y", "tavily-mcp"], env: { TAVILY_API_KEY: "" }, category: "Search" },
  { name: "fetch", desc: "HTTP fetch and URL reading", command: "npx", args: ["-y", "@modelcontextprotocol/server-fetch"], env: {}, category: "Search" },
  // Development
  { name: "context7", desc: "Up-to-date docs for any library", command: "npx", args: ["-y", "@upstash/context7-mcp@latest"], env: {}, category: "Development" },
  { name: "playwright", desc: "Browser automation & testing", command: "npx", args: ["-y", "@anthropic-ai/mcp-server-playwright"], env: {}, category: "Development" },
  { name: "puppeteer", desc: "Chrome browser automation", command: "npx", args: ["-y", "@anthropic-ai/mcp-server-puppeteer"], env: {}, category: "Development" },
  { name: "git", desc: "Git repository operations", command: "uvx", args: ["mcp-server-git"], env: {}, category: "Development" },
  { name: "sequential-thinking", desc: "Dynamic problem-solving chains", command: "npx", args: ["-y", "@anthropic-ai/mcp-server-sequential-thinking"], env: {}, category: "Development" },
  // Files & System
  { name: "filesystem", desc: "Secure local file access", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."], env: {}, category: "Files" },
  { name: "memory", desc: "Persistent knowledge graph", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], env: {}, category: "Files" },
  // Database
  { name: "postgres", desc: "PostgreSQL database access", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"], env: {}, category: "Database" },
  { name: "sqlite", desc: "SQLite database operations", command: "npx", args: ["-y", "@modelcontextprotocol/server-sqlite", "--db-path", "./db.sqlite"], env: {}, category: "Database" },
  { name: "redis", desc: "Redis cache & data store", command: "npx", args: ["-y", "@modelcontextprotocol/server-redis", "redis://localhost:6379"], env: {}, category: "Database" },
  { name: "supabase", desc: "Supabase backend platform", command: "npx", args: ["-y", "@supabase/mcp-server-supabase@latest"], env: { SUPABASE_ACCESS_TOKEN: "" }, category: "Database" },
  // Cloud & DevOps
  { name: "cloudflare", desc: "Cloudflare Workers & KV", command: "npx", args: ["-y", "@cloudflare/mcp-server-cloudflare"], env: {}, category: "Cloud" },
  { name: "vercel", desc: "Vercel deployment platform", command: "npx", args: ["-y", "vercel-mcp-server"], env: { VERCEL_TOKEN: "" }, category: "Cloud" },
  { name: "aws-kb-retrieval", desc: "AWS Bedrock knowledge bases", command: "npx", args: ["-y", "@modelcontextprotocol/server-aws-kb-retrieval"], env: { AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" }, category: "Cloud" },
  { name: "docker", desc: "Docker container management", command: "npx", args: ["-y", "mcp-server-docker"], env: {}, category: "Cloud" },
  // Communication
  { name: "slack", desc: "Slack workspace integration", command: "npx", args: ["-y", "@anthropic-ai/mcp-server-slack"], env: { SLACK_BOT_TOKEN: "" }, category: "Communication" },
  // Productivity
  { name: "github", desc: "GitHub repos, issues, PRs", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" }, category: "Productivity" },
  { name: "linear", desc: "Linear issue tracking", command: "npx", args: ["-y", "mcp-linear"], env: { LINEAR_API_KEY: "" }, category: "Productivity" },
  { name: "notion", desc: "Notion workspace access", command: "npx", args: ["-y", "@notionhq/mcp-server-notion"], env: { NOTION_API_KEY: "" }, category: "Productivity" },
  { name: "google-maps", desc: "Google Maps & Places API", command: "npx", args: ["-y", "@modelcontextprotocol/server-google-maps"], env: { GOOGLE_MAPS_API_KEY: "" }, category: "Productivity" },
  { name: "todoist", desc: "Todoist task management", command: "npx", args: ["-y", "todoist-mcp-server"], env: { TODOIST_API_TOKEN: "" }, category: "Productivity" },
  // Data & Analytics
  { name: "sentry", desc: "Sentry error tracking", command: "npx", args: ["-y", "@modelcontextprotocol/server-sentry"], env: { SENTRY_AUTH_TOKEN: "" }, category: "Data" },
  // AI & Generation
  { name: "everart", desc: "AI image generation", command: "npx", args: ["-y", "@modelcontextprotocol/server-everart"], env: { EVERART_API_KEY: "" }, category: "AI" },
];

// Known GitHub repos for curated entries whose npm package can't be resolved to
// one (the official @modelcontextprotocol/server-* packages have no repository
// field, and several aren't even published, so they all live in the servers
// monorepo). Pre-seeding full_name lets the star enrichment skip the npm lookup
// and fetch stars directly (deduped per repo). Entries not listed here fall back
// to npm->repo resolution (works for standalone packages like todoist, docker).
const MCP_SERVERS_MONOREPO = "modelcontextprotocol/servers";
export const CURATED_MCP_REPOS = {
  "brave-search": MCP_SERVERS_MONOREPO, "fetch": MCP_SERVERS_MONOREPO, "filesystem": MCP_SERVERS_MONOREPO,
  "memory": MCP_SERVERS_MONOREPO, "postgres": MCP_SERVERS_MONOREPO, "sqlite": MCP_SERVERS_MONOREPO,
  "redis": MCP_SERVERS_MONOREPO, "aws-kb-retrieval": MCP_SERVERS_MONOREPO, "github": MCP_SERVERS_MONOREPO,
  "google-maps": MCP_SERVERS_MONOREPO, "sentry": MCP_SERVERS_MONOREPO, "everart": MCP_SERVERS_MONOREPO,
  "slack": MCP_SERVERS_MONOREPO, "git": MCP_SERVERS_MONOREPO, "sequential-thinking": MCP_SERVERS_MONOREPO,
  "puppeteer": MCP_SERVERS_MONOREPO,
  "exa": "exa-labs/exa-mcp-server", "tavily": "tavily-ai/tavily-mcp", "context7": "upstash/context7",
  "playwright": "microsoft/playwright-mcp", "cloudflare": "cloudflare/mcp-server-cloudflare",
  "notion": "makenotion/notion-mcp-server", "supabase": "supabase-community/supabase-mcp",
};

// these are hand-picked, verified packages; the flag drives the marketplace
// curated marker and the npm->repo->stars enrichment. A pre-seeded full_name (when
// known) lets enrichment fetch stars directly. registry entries pushed in at
// runtime carry no curated flag, which is correct.
MCP_CATALOG.forEach(function (e) { e.curated = true; if (CURATED_MCP_REPOS[e.name]) e.full_name = CURATED_MCP_REPOS[e.name]; });

// First-party plugins maintained by the intisy-ai org, loaded from data/official-plugins.json
// (kept as data, not code, so this module carries no hardcoded plugin catalog). Statically
// imported (not readFileSync'd at runtime) so esbuild inlines the data when core-loader gets
// bundled into a loader's single dist/plugin.js, where __dirname no longer has a data/ sibling.
// Always shown at the top of the marketplace in a dedicated "Official · intisy-ai" section,
// present regardless of whether the remote catalog fetch has completed.
export const OFFICIAL_PLUGINS = officialPluginsData;
// mark every entry so downstream code can test e.official without string comparisons
OFFICIAL_PLUGINS.forEach(function(e) { e.official = true; });

// Popular marketplaces seeded into Level 1 for every user, even before they've
// added them to the host app. name -> github "owner/repo"; marketplace.ts fetches
// each repo's .claude-plugin/marketplace.json (HEAD, falling back to main/master)
// to derive a plugin count + drill-in list, cached on disk (see fetchSeedMarketplacesAsync).
// Verified list, do NOT add unverified repos here.
export const DEFAULT_MARKETPLACES = [
  { name: "claude-plugins-official", repo: "anthropics/claude-plugins-official" },
  { name: "claude-plugins-community", repo: "anthropics/claude-plugins-community" },
  { name: "superpowers", repo: "obra/superpowers-marketplace" },
  { name: "wshobson-agents", repo: "wshobson/agents" },
  { name: "claude-code-templates", repo: "davila7/claude-code-templates" },
  { name: "ecc", repo: "affaan-m/ECC" },
  { name: "xiaolai", repo: "xiaolai/claude-plugin-marketplace" },
  { name: "claude-mem", repo: "thedotmack/claude-mem" },
  { name: "superpowers-plugin", repo: "obra/superpowers" },
  { name: "wshobson-commands", repo: "wshobson/commands" },
  { name: "anthropics-skills", repo: "anthropics/skills" },
  { name: "voltagent-subagents", repo: "VoltAgent/awesome-claude-code-subagents" },
  { name: "furai-subagents", repo: "0xfurai/claude-code-subagents" },
  { name: "context-engineering-kit", repo: "NeoLabHQ/context-engineering-kit" },
  { name: "claude-skills-marketplace", repo: "mhattingpete/claude-skills-marketplace" },
];

// Standalone individual plugin repos (not marketplaces) curated for a built-in
// "Featured" catalog shown in Level 1 alongside "intisy-ai (official)"/"community"
// (see marketplace.ts loaderOwnMarketplaces). Each installs like any other
// catalog plugin, git clone via the updater, using the derived .url below;
// there is no marketplace.json to fetch, so these never go through the seed
// fetch machinery. Verified list, do NOT add unverified repos here.
export const FEATURED_PLUGINS = [
  { name: "claude-mem", repo: "thedotmack/claude-mem", description: "Persistent cross-session memory (capture/compress/reinject)", category: "memory" },
  { name: "hindsight", repo: "vectorize-io/hindsight", description: "Agent memory that learns (+ hindsight-skills)", category: "memory" },
  { name: "context7", repo: "upstash/context7", description: "Up-to-date library docs for LLMs via MCP", category: "docs" },
  { name: "claude-hud", repo: "jarrodwatts/claude-hud", description: "HUD statusline: context/tools/agents/todos", category: "statusline" },
  { name: "claude-code-usage-bar", repo: "leeguooooo/claude-code-usage-bar", description: "Statusline: rate-limit usage, resets, model/context", category: "statusline" },
  { name: "cartographer", repo: "kingbootoshi/cartographer", description: "Maps/documents codebases via parallel subagents", category: "codebase" },
  { name: "dev-browser", repo: "SawyerHood/dev-browser", description: "Real web browser for the agent (Playwright)", category: "browser" },
  { name: "playwright-skill", repo: "lackeyjb/playwright-skill", description: "Model-invoked Playwright browser automation", category: "browser" },
  { name: "skill-seekers", repo: "yusufkaraaslan/Skill_Seekers", description: "Convert docs/repos/PDFs into Claude skills", category: "authoring" },
  { name: "ios-simulator-skill", repo: "conorluddy/ios-simulator-skill", description: "Build/run/interact with iOS Simulator", category: "mobile" },
  { name: "claude-code-otel", repo: "ColeMurray/claude-code-otel", description: "OpenTelemetry -> Grafana observability for CC", category: "observability" },
  { name: "aws-skills", repo: "zxkane/aws-skills", description: "AWS dev skills (CDK/SST, serverless, cost, Bedrock)", category: "cloud" },
  { name: "ui-craft", repo: "educlopez/ui-craft", description: "Design-engineering skill for craft-quality UI", category: "design" },
  { name: "claude-epub-skill", repo: "smerchek/claude-epub-skill", description: "Markdown -> EPUB (send-to-Kindle)", category: "documents" },
  { name: "openweb", repo: "openweb-org/openweb", description: "Agent-native access to 90+ websites via APIs", category: "integration" },
  { name: "tapestry-skills", repo: "michalparkola/tapestry-skills", description: "Download articles/PDFs/YouTube transcripts", category: "research" },
];
// derive the fields the generic catalog-item install/select machinery expects
// (selectionKey, getMarketplaceActions, marketplaceRow) from the raw schema
FEATURED_PLUGINS.forEach(function(e) {
  var parts = e.repo.split("/");
  e.author = parts[0];
  e.repoName = parts[1];
  e.full_name = e.repo;
  e.url = "https://github.com/" + e.repo + ".git";
  e.desc = e.description;
  e.featured = true;
  // categories double as section headings in the list, capitalize for display
  e.category = e.category.charAt(0).toUpperCase() + e.category.slice(1);
});

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const HELP_BINDINGS = {
  projects: [
    ["^v / WS", "Move"], ["Enter / Space", "Open actions"], ["O", "Open project"],
    ["P", "Pin / unpin"], ["H", "Hide project"], ["U", "Unhide all"],
    ["C", "Open custom path"], ["<- ->", "Switch page"], ["Q / Esc", "Quit"],
  ],
  plugins: [
    ["^v / WS", "Move"], ["Enter", "Plugin actions / open marketplace"], ["Tab", "Installed / Marketplace / Providers"],
    ["F", "Check for updates"], ["R", "Refresh list / catalog"], ["U", "Update selected"],
    ["A", "Update all"], ["E", "Update updater engine"], ["D", "Disable selected"], ["I", "Quick install (marketplace)"],
    ["/", "Search (marketplace)"], ["[ / ]", "Jump group (marketplace)"], ["Esc", "Back out of a marketplace"],
    ["<- ->", "Switch page"], ["Q", "Quit"],
  ],
  mcp: [
    ["^v / WS", "Move"], ["Enter", "Server actions"], ["Tab", "Installed / Marketplace"],
    ["I", "Install selected"], ["X", "Uninstall selected"], ["R", "Refresh catalog"],
    ["/", "Search"], ["<- ->", "Switch page"], ["Q / Esc", "Quit"],
  ],
  settings: [
    ["^v / WS", "Move"], ["Enter", "Open a group / edit a setting"],
    ["Tab", "Switch sub-tab (Settings / contributed screens)"],
    ["<- ->", "Switch page"], ["Q / Esc", "Quit"],
  ],
};
