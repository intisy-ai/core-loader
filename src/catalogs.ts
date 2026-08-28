// Third-party catalog data: MCP servers, seeded marketplaces and curated standalone plugin repos.
// Every name here is a SOURCE (someone else's repository or package), not this app's identity,
// which is why the app-name guard excuses this one file and no other.

/** One curated MCP server, as this file's catalog declares it. */
export interface McpCatalogEntry {
  /** The server's name, which is also the key it is configured under. */
  name: string;
  /** One line about what it does. */
  desc: string;
  /** The command that starts it. */
  command: string;
  /** That command's arguments. */
  args: string[];
  /** The environment it needs, usually the API keys, empty-valued here. */
  env: Record<string, string>;
  /** The heading it is grouped under. */
  category: string;
  /** Set on every entry this file declares, which is what marks it hand-verified. */
  curated?: boolean;
  /** The repository's `owner/name`, so star enrichment can fetch directly. */
  full_name?: string;
  /** Its GitHub star count, filled in by enrichment. */
  stars?: number;
}

/** One seeded marketplace: a name and the repository whose manifest is fetched for it. */
export interface SeedMarketplaceEntry {
  /** What the level-1 row is shown as. */
  name: string;
  /** The `owner/repo` its manifest is read from. */
  repo: string;
}

/**
 * One curated standalone plugin repository.
 *
 * @remarks
 * The last five fields are DERIVED from `repo` at module load, not declared per entry, which is
 * why they are optional: the raw list stays two names and a sentence per line.
 */
export interface FeaturedPluginEntry {
  /** What the row is shown as. */
  name: string;
  /** The `owner/repo` it is cloned from. */
  repo: string;
  /** One line about what it does. */
  description: string;
  /** The heading it is grouped under, capitalised for display once derived. */
  category: string;
  /** The GitHub account that owns it. */
  author?: string;
  /** The repository's own name. */
  repoName?: string;
  /** The repository's `owner/name`, which is its identity in a selection. */
  full_name?: string;
  /** Its clone URL. */
  url?: string;
  /** The description, under the key every catalog row uses. */
  desc?: string;
  /** Set on every entry here, which is what routes it to the Featured list. */
  featured?: boolean;
}

/** MCP Server Catalog (curated, verified packages) */
export const MCP_CATALOG: McpCatalogEntry[] = [
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
/** The repository behind each curated MCP server, where it is known, so star enrichment can skip the npm lookup. */
export const CURATED_MCP_REPOS: Record<string, string> = {
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

/**
 * Popular marketplaces seeded into Level 1 for every user, even before they've
 * added them to the host app. name -> github "owner/repo"; marketplace.ts fetches
 * each repo's .claude-plugin/marketplace.json (HEAD, falling back to main/master)
 * to derive a plugin count + drill-in list, cached on disk (see fetchSeedMarketplacesAsync).
 * Verified list, do NOT add unverified repos here.
 */
export const DEFAULT_MARKETPLACES: SeedMarketplaceEntry[] = [
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

/**
 * Standalone individual plugin repos (not marketplaces) curated for a built-in
 * "Featured" catalog shown in Level 1 alongside "community" and any declared
 * marketplace source (see marketplace.ts loaderOwnMarketplaces). Each installs
 * like any other catalog plugin, git clone via the updater, using the derived
 * .url below; there is no marketplace.json to fetch, so these never go through
 * the seed fetch machinery. Verified list, do NOT add unverified repos here.
 */
export const FEATURED_PLUGINS: FeaturedPluginEntry[] = [
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

/**
 * The de-facto marketplace manifest path every seeded marketplace repo publishes. A third party's
 * file format, read identically whatever app is running.
 */
export const MARKETPLACE_MANIFEST_PATH = ".claude-plugin/marketplace.json";

/**
 * The manifest key several provider repositories publish in their own package.json to declare the
 * auth providers they carry. Renaming it is a cross-repo change, so this library reads it as given.
 */
export const PROVIDER_MANIFEST_KEY = "claudeHub";
